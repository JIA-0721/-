// backend/server.js
const { WebSocketServer } = require('ws');

const wss = new WebSocketServer({ port: 8080 });
console.log('🚀 后端 WebSocket 网关已在端口 8080 启动...');

wss.on('connection', (ws) => {
    console.log('🤝 前端客户端已连接');

    ws.on('message', (message, isBinary) => {
        if (isBinary) {
            console.log(`🎙️ [收到有效音频] 大小: ${message.length} 字节`);
            // TODO: 直接转发给大模型 Live API 
        } else {
            try {
                const obj = JSON.parse(message.toString());
                
                if (obj.type === 'video') {
                    console.log(`📸 收到视频帧 [Base64], 长度: ${obj.data.length}`);
                } 

                else if (obj.type === 'control') {
                    if (obj.action === 'speech_start') {
                        console.log("⚠️ [后端收到指令] 用户开始说话：如果 AI 正在播放声音，应立即执行打断(Barge-in)！");
                    } else if (obj.action === 'speech_stop') {
                        console.log("🛑 [后端收到指令] 用户说完了：准备让大模型根据收到的音频和画面进行最终推理...");
                    }
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