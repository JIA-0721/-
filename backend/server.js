// backend/server.js
const { WebSocketServer } = require('ws');

const wss = new WebSocketServer({ port: 8080 });
console.log('🚀 后端 WebSocket 网关已在端口 8080 启动...');

wss.on('connection', (ws) => {
    console.log('🤝 前端客户端已连接');

    ws.on('message', (message, isBinary) => {
        if (isBinary) {
            // 收到的是原始音频流 (Int16 PCM)
            // console.log(`🎙️ 收到音频流数据片，大小: ${message.length} 字节`);
            // TODO: 这里后续接入本地 VAD 或直接转发给 AI Cloud 实时语音 API
        } else {
            // 收到的是 JSON 字符串（视频帧或其他控制文本）
            try {
                const obj = JSON.parse(message.toString());
                if (obj.type === 'video') {
                    console.log(`📸 收到视频关键帧 [Base64], 长度: ${obj.data.length}`);
                    // TODO: 后续在这里做【帧差法】对比，画面没变就不调大模型，节省 Token！
                    
                    // 模拟 AI 发现了东西，给前端一个假回应
                    ws.send("AI 正在看着你呢...");
                }
            } catch (e) {
                console.error("解析 JSON 失败", e);
            }
        }
    });

    ws.on('close', () => {
        console.log('🔌 客户端连接断开');
    });
});