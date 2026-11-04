FROM docker.m.daocloud.io/library/debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3
RUN sed -i 's|http://deb.debian.org/debian-security|http://mirrors.tuna.tsinghua.edu.cn/debian-security|g; s|http://deb.debian.org/debian|http://mirrors.tuna.tsinghua.edu.cn/debian|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=1 -o Acquire::http::Timeout=20 update \
    && apt-get -o Acquire::Retries=1 -o Acquire::http::Timeout=20 install -y --no-install-recommends ca-certificates \
    && sed -i 's|http://mirrors|https://mirrors|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=1 -o Acquire::https::Timeout=30 install -y --no-install-recommends chromium python3 python3-websocket \
    && rm -rf /var/lib/apt/lists/*
COPY action.py /opt/action.py
USER 65534:65534
ENTRYPOINT ["chromium", "--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run", "--user-data-dir=/tmp/profile", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9222", "--remote-allow-origins=http://localhost", "about:blank"]
