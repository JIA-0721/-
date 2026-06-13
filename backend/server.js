// backend/server.js
// Gemini Live API + REST API 双轨智能中继服务器
// 架构: 
// 1. [前端 Client] <--WS--> [本服务器] <--WSS--> [Gemini Live API] (Premium 轨)
// 2. [前端 Client] <--HTTP POST--> [本服务器] <--HTTPS--> [Gemini REST API] (Free 轨)

require('dotenv').config();
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PREMIUM_MODEL = 'gemini-3.1-flash-live-preview';
const FREE_MODEL = 'gemini-3.1-flash-lite';

const GEMINI_LIVE_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

const SYSTEM_INSTRUCTION = `你是一个实时的多模态视觉语音助手。你能看到用户摄像头的画面，也能听到用户说的话。
请根据用户说的话以及摄像头拍到的画面进行回答。
你的语气要口语化、亲切自然，像朋友聊天一样。
回答尽量简短精炼，控制在2-3句话以内，适合语音播报。
请用中文回答。`;

// ==========================================
// 1. 免费轨道：处理 gemini-3.1-flash-lite 的 REST 请求
// ==========================================
async function callGeminiFlashLite(prompt) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${FREE_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    
    const payload = {
        contents: [{
            parts: [{ text: prompt }]
        }],
        systemInstruction: {
            parts: [{ text: SYSTEM_INSTRUCTION }]
        }
    };

    console.log(`📡 [Free Track] 正在请求 ${FREE_MODEL}...`);
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Gemini REST API 错误: ${response.status} - ${errText}`);
    }

    const data = await response.json();
    
    let reply = '';
    if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts[0]) {
        reply = data.candidates[0].content.parts[0].text;
    }

    const usageMetadata = data.usageMetadata || {
        promptTokenCount: 0,
        candidatesTokenCount: 0,
        totalTokenCount: 0
    };

    console.log(`✅ [Free Track] 成功获取回复. Tokens used: ${usageMetadata.totalTokenCount}`);
    return { reply, usageMetadata };
}

// ==========================================
// 2. 创建 HTTP 服务器 (处理 REST 请求 + 服务托管)
// ==========================================
const server = http.createServer((req, res) => {
    // 允许跨域 (CORS)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // 处理免费轨的对话请求
    if (req.url === '/api/chat-free' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const { text } = JSON.parse(body);
                if (!text) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Missing parameter: text' }));
                    return;
                }
                const result = await callGeminiFlashLite(text);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } catch (err) {
                console.error('❌ Free Track 失败:', err.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
        });
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
});

// ==========================================
// 3. 高级轨道：建立 WebSocket 服务器
// ==========================================
const wss = new WebSocketServer({ server });

wss.on('connection', (clientWs) => {
    console.log('\n🤝 前端客户端已连接 WebSocket (Premium Live 轨)');

    let geminiWs = null;
    let isGeminiReady = false;

    // 建立到 Gemini Live API 的连接
    function connectToGemini() {
        console.log(`🔗 [Premium Track] 正在连接 Gemini Live API (${PREMIUM_MODEL})...`);
        geminiWs = new WebSocket(GEMINI_LIVE_WS_URL);

        geminiWs.on('open', () => {
            console.log('✅ [Premium Track] Gemini Live API WebSocket 已连接');

            const setupMessage = {
                setup: {
                    model: `models/${PREMIUM_MODEL}`,
                    generationConfig: {
                        responseModalities: ['AUDIO'],
                        speechConfig: {
                            voiceConfig: {
                                prebuiltVoiceConfig: { voiceName: 'Aoede' }
                            }
                        }
                    },
                    systemInstruction: {
                        parts: [{ text: SYSTEM_INSTRUCTION }]
                    },
                    inputAudioTranscription: {},
                    outputAudioTranscription: {}
                }
            };

            geminiWs.send(JSON.stringify(setupMessage));
            console.log('📤 已发送 Setup 配置');
        });

        // 接收并转发 Gemini 返回的消息
        geminiWs.on('message', (data) => {
            try {
                const rawStr = data.toString();
                const response = JSON.parse(rawStr);

                // Setup 完成确认
                if (response.setupComplete) {
                    isGeminiReady = true;
                    console.log('🎯 Gemini Live API 会话初始化完成，可以开始交互');
                    if (clientWs.readyState === WebSocket.OPEN) {
                        clientWs.send(JSON.stringify({ type: 'ready' }));
                    }
                    return;
                }

                // 转发 Token 消耗数据 (重要)
                if (response.usageMetadata) {
                    if (clientWs.readyState === WebSocket.OPEN) {
                        clientWs.send(JSON.stringify({
                            type: 'usage',
                            usageMetadata: response.usageMetadata
                        }));
                    }
                }

                if (response.serverContent) {
                    const sc = response.serverContent;

                    // 转发 AI 语音数据给前端
                    if (sc.modelTurn && sc.modelTurn.parts) {
                        for (const part of sc.modelTurn.parts) {
                            if (part.inlineData) {
                                if (clientWs.readyState === WebSocket.OPEN) {
                                    clientWs.send(JSON.stringify({
                                        type: 'audio',
                                        data: part.inlineData.data,
                                        mimeType: part.inlineData.mimeType
                                    }));
                                }
                            }
                        }
                    }

                    // 转发输入转录（用户说了什么）
                    if (sc.inputTranscription && sc.inputTranscription.text) {
                        console.log(`🎤 用户: "${sc.inputTranscription.text}"`);
                        if (clientWs.readyState === WebSocket.OPEN) {
                            clientWs.send(JSON.stringify({
                                type: 'input_transcription',
                                text: sc.inputTranscription.text
                            }));
                        }
                    }

                    // 转发输出转录（AI 说了什么）
                    if (sc.outputTranscription && sc.outputTranscription.text) {
                        console.log(`🤖 AI: "${sc.outputTranscription.text}"`);
                        if (clientWs.readyState === WebSocket.OPEN) {
                            clientWs.send(JSON.stringify({
                                type: 'output_transcription',
                                text: sc.outputTranscription.text
                            }));
                        }
                    }

                    // 模型回合结束标志
                    if (sc.turnComplete) {
                        if (clientWs.readyState === WebSocket.OPEN) {
                            clientWs.send(JSON.stringify({ type: 'turn_complete' }));
                        }
                    }

                    // 被打断标志
                    if (sc.interrupted) {
                        console.log('⚡ 用户打断了 AI');
                        if (clientWs.readyState === WebSocket.OPEN) {
                            clientWs.send(JSON.stringify({ type: 'interrupted' }));
                        }
                    }
                }

            } catch (e) {
                console.error('❌ 解析 Gemini 响应失败:', e.message);
            }
        });

        geminiWs.on('error', (err) => {
            console.error('❌ Gemini Live API 连接错误:', err.message);
            if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({
                    type: 'error',
                    text: `Gemini 连接错误: ${err.message}`
                }));
            }
        });

        geminiWs.on('close', (code, reason) => {
            const reasonStr = reason ? reason.toString() : 'no reason';
            console.log(`🔌 Gemini Live API 连接断开 (code: ${code}, reason: ${reasonStr})`);
            isGeminiReady = false;
            if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({ type: 'gemini_disconnected' }));
            }
        });
    }

    // 建立连接
    connectToGemini();

    // 接收前端的数据，转发给 Gemini
    let audioChunkCount = 0;
    let videoFrameCount = 0;

    clientWs.on('message', (message) => {
        if (!isGeminiReady || !geminiWs || geminiWs.readyState !== WebSocket.OPEN) {
            return;
        }

        try {
            const obj = JSON.parse(message.toString());

            // 转发音频
            if (obj.type === 'audio') {
                const audioMessage = {
                    realtimeInput: {
                        audio: {
                            data: obj.data,
                            mimeType: 'audio/pcm;rate=16000'
                        }
                    }
                };
                geminiWs.send(JSON.stringify(audioMessage));
                audioChunkCount++;
                if (audioChunkCount % 50 === 1) {
                    console.log(`🎤 已转发 ${audioChunkCount} 个音频块`);
                }
            }

            // 转发视频帧
            else if (obj.type === 'video') {
                const videoMessage = {
                    realtimeInput: {
                        video: {
                            data: obj.data,
                            mimeType: 'image/jpeg'
                        }
                    }
                };
                geminiWs.send(JSON.stringify(videoMessage));
                videoFrameCount++;
                if (videoFrameCount % 10 === 1) {
                    console.log(`📹 已转发 ${videoFrameCount} 帧视频`);
                }
            }

        } catch (e) {
            console.error('❌ 解析前端数据失败:', e.message);
        }
    });

    clientWs.on('close', () => {
        console.log('🔌 前端客户端断开');
        if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
            geminiWs.close();
        }
    });

    clientWs.on('error', (err) => {
        console.error('❌ 前端 WebSocket 错误:', err.message);
    });
});

// 开启合并服务
server.listen(8080, () => {
    console.log('🚀 双轨中继服务器已启动 [Port 8080]');
    console.log(`📡 免费轨: ${FREE_MODEL} (REST API)`);
    console.log(`📡 高级轨: ${PREMIUM_MODEL} (WebSocket)`);
});