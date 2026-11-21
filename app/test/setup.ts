// 测试不读本机的着色插件（skill 的 tones.py）：本机放了 private/tone_plugin.py 或 .env 里配了，起真 Python 的测试结果也不变。
process.env.DMA_TONE_PLUGIN = "";
