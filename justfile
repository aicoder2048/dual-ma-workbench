# 启动归雁工作台：just goose，或 just goose 5179 换端口
goose port="5178":
    cd app && PORT={{port}} bun start
