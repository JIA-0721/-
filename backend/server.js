// backend/server.js
// Gemini Live API 双向中继服务器
// 架构: [前端 Client] <--WS--> [本服务器] <--WSS--> [Gemini Live API]
require('dotenv').config();
const { WebSocketServer, WebSocket } = require('ws');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL_NAME = 'gemini-3.1-flash-live-preview';
const GEMINI_LIVE_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

const SYSTEM_INSTRUCTION = `你是一个实时的多模态视觉语音助手。你能看到用户摄像头的画面，也能听到用户说的话。
请根据用户说的话以及摄像头拍到的画面进行回答。
你的语气要口语化、亲切自然，像朋友聊天一样。
回答尽量简短精炼，控制在2-3句话以内，适合语音播报。
请用中文回答。`;

// 启动面向前端的 WebSocket 服务器
const wss = new WebSocketServer({ port: 8080 });
console.log('🚀 Gemini Live API 中继网关已启动 [Port 8080]');
console.log(`📡 模型: ${MODEL_NAME}`);

wss.on('connection', (clientWs) => {
    console.log('\n🤝 前端客户端已连接');

    let geminiWs = null;
    let isGeminiReady = false;

    // 1. 为该客户端建立到 Gemini Live API 的 WebSocket 连接
    function connectToGemini() {
        console.log('🔗 正在连接 Gemini Live API...');

        geminiWs = new WebSocket(GEMINI_LIVE_WS_URL);

        geminiWs.on('open', () => {
            console.log('✅ Gemini Live API WebSocket 已连接');

            // 发送初始化配置 (BidiGenerateContentSetup)
            const setupMessage = {
                setup: {
                    model: `models/${MODEL_NAME}`,
                    generationConfig: {
                        responseModalities: ['AUDIO'],
                        speechConfig: {
                            voiceConfig: {
                                prebuiltVoiceConfig: {
                                    voiceName: 'Aoede' // 女声，适合中文
                                }
                            }
                        }
                    },
                    systemInstruction: {
                        parts: [{ text: SYSTEM_INSTRUCTION }]
                    },
                    // 开启输入输出音频转录，用于前端字幕显示
                    inputAudioTranscription: {},
                    outputAudioTranscription: {}
                }
            };

            geminiWs.send(JSON.stringify(setupMessage));
            console.log('📤 已发送 Setup 配置');
        });

        // 处理 Gemini 返回的消息
        geminiWs.on('message', (data) => {
            try {
                const rawStr = data.toString();
                const response = JSON.parse(rawStr);

                // Setup 完成确认
                if (response.setupComplete) {
                    isGeminiReady = true;
                    console.log('🎯 Gemini Live API 会话初始化完成，可以开始交互');
                    // 通知前端可以开始了
                    if (clientWs.readyState === WebSocket.OPEN) {
                        clientWs.send(JSON.stringify({ type: 'ready' }));
                    }
                    return;
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
                clientWs.send(JSON.stringify({
                    type: 'gemini_disconnected'
                }));
            }
        });
    }

    // 建立到 Gemini 的连接
    connectToGemini();

    // 2. 处理前端发来的数据，转发给 Gemini
    let audioChunkCount = 0;
    let videoFrameCount = 0;

    clientWs.on('message', (message) => {
        if (!isGeminiReady || !geminiWs || geminiWs.readyState !== WebSocket.OPEN) {
            return;
        }

        try {
            const obj = JSON.parse(message.toString());

            // 前端发来的音频数据 -> 转发给 Gemini
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
                    console.log(`🎤 已转发 ${audioChunkCount} 个音频块 (最新数据长度: ${obj.data.length} chars)`);
                }
            }

            // 前端发来的视频帧 -> 转发给 Gemini
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
                console.log(`📹 已转发第 ${videoFrameCount} 帧视频 (数据长度: ${obj.data.length} chars)`);
            }

        } catch (e) {
            console.error('❌ 解析前端数据失败:', e.message);
        }
    });

    // 3. 前端断开时，同时断开 Gemini 连接
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