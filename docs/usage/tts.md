# 让 momo 开口说话

momo 支持 IndexTTS 和 GPT-SoVITS。语音合成可以自行部署，文字对话可独立使用。

## 连接语音服务

1. 打开「设置 → 模型 → 语音合成」，选择合成引擎。
2. 填写管理页显示的服务地址和 API 密钥。例如管理页为 `http://192.168.1.20:19890` 时，IndexTTS 用 `http://192.168.1.20:19890/index`，GPT-SoVITS 用 `http://192.168.1.20:19890/gpt`。两种引擎各自记住地址和密钥。
3. 上传你有权使用的参考音频。建议用 3–10 秒、单人、清晰且无背景音乐的录音。GPT-SoVITS 的参考文本填写录音中的原话。
4. 点击地址旁的播放图标试听。合成输出语言跟随对话语言。

普通话音色可先用清晰的普通话参考音试配。[AISHELL-3](https://www.openslr.org/93/) 是带逐句转录的普通话语音合成语料。

## 部署语音引擎

两个引擎及完整部署说明都在 [momo-tts](https://github.com/Momoyeyu/momo-tts)。需要一台有 NVIDIA GPU 的 Linux 主机，以及用于模型、依赖和缓存的数据盘。`make deploy` 启动管理服务。默认使用用户数据目录，也可通过 `DATA_ROOT` 或管理页设置一个公共数据目录。两种引擎各自创建需要的子目录。

```sh
make deploy
make configure ENGINE=index GPU=GPU-your-device-uuid
make prepare ENGINE=index
make bootstrap ENGINE=index
make set-reference ENGINE=index REFERENCE=/path/to/reference.wav LANGUAGE=zh
make deploy ENGINE=index
```

GPT-SoVITS 使用 `ENGINE=gpt`，设置参考音时填写 `PROMPT` 作为参考音的完整台词。两个引擎都支持 `make status`、`make probe`、`make restart` 和 `make rollback`。更新和热重启会先验证新进程的合成能力，然后切换新请求。

## 网页管理

管理员在服务器运行 `make deploy` 后，从局域网直接打开终端打印的管理页地址。登录后可以选择引擎、准备模型、设置验证参考音、试合成、发布和回滚。两种引擎的服务地址和 API 密钥可在管理页查看。

管理页使用独立的管理员密钥，服务器端保存于 `~/.config/momo-tts/admin-key`。局域网默认入口使用 HTTP。需要加密传输时，可为管理页和合成接口统一配置 HTTPS。 [momo-tts 部署指南](https://github.com/Momoyeyu/momo-tts#readme)
