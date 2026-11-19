# 启动归雁工作台：just wildgoose，或 just wildgoose 5179 换端口
wildgoose port="5178":
    cd app && PORT={{port}} exec bun src/server.ts
