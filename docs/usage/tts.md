# 让 momo 开口说话

momo 支持 IndexTTS 和 GPT-SoVITS。语音合成可以自行部署，文字对话可独立使用。

## 连接语音服务

1. 打开「设置 → 模型 → 语音合成」，选择合成引擎。
2. 填写对应地址和 API 密钥。通过 SSH 转发时，IndexTTS 用 `http://127.0.0.1:19880`，GPT-SoVITS 用 `http://127.0.0.1:19884`。两种引擎各自记住地址和密钥。
3. 上传你有权使用的参考音频。建议用 3–10 秒、单人、清晰且无背景音乐的录音。GPT-SoVITS 的参考文本填写录音中的原话。
4. 点击地址旁的播放图标试听。合成输出语言跟随对话语言。

普通话音色可先用清晰的普通话参考音试配。[AISHELL-3](https://www.openslr.org/93/) 是带逐句转录的普通话语音合成语料。

## 部署语音引擎

两个引擎及完整部署说明都在 [momo-tts](https://github.com/Momoyeyu/momo-tts)。需要一台有 NVIDIA GPU 的 Linux 主机，以及用于模型、依赖和缓存的数据盘。管理员先配置磁盘目录和 GPU，准备模型后再启动网关。

```sh
make configure ENGINE=index DATA_DIR=/path/to/model-disk/index GPU=GPU-your-device-uuid
make prepare ENGINE=index
make bootstrap ENGINE=index
make set-reference ENGINE=index REFERENCE=/path/to/reference.wav LANGUAGE=zh
make deploy ENGINE=index
```

GPT-SoVITS 使用 `ENGINE=gpt`，设置参考音时填写 `PROMPT` 作为参考音的完整台词。两个引擎都支持 `make status`、`make probe`、`make restart` 和 `make rollback`。更新和热重启会先验证新进程的合成能力，然后切换新请求。

## 网页管理

管理员运行 `make install`，将服务器的 19890 端口转发到自己的电脑后，打开 `http://127.0.0.1:19890`。在管理页可查看引擎状态、设置验证参考音、准备模型、试合成、发布、热重启和回滚。

```sh
ssh -N -o ExitOnForwardFailure=yes \
    -L 19880:127.0.0.1:19880 \
    -L 19884:127.0.0.1:19884 \
    -L 19890:127.0.0.1:19890 user@gpu-host
```

合成密钥由管理员通过私有渠道提供。管理页使用独立的管理员密钥，由服务器的 `~/.config/momo-tts/admin-key` 保存。
