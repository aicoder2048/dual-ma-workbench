# 启动归雁工作台：just wildgoose，或 just wildgoose 5179 换端口。
# 改了 app/src 的代码会自动重启（--watch）；改了 SKILL.md、学习文章，页面顶部会提示手动重启。
wildgoose port="5178":
    cd app && PORT={{port}} exec bun --watch src/server.ts
