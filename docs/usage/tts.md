# 让 momo 开口说话

语音是可选功能。文字对话不依赖 GPU 服务。已有兼容的 GPT-SoVITS 服务时，可以直接连接；需要自行部署时，使用仓库的 [`deploy/tts/`](../../deploy/tts/)。

当前应用不附带默认参考音或游戏角色语音。参考音由玩家自行提供，个人样本不随仓库、安装包或部署镜像分发。

## 在 momo 中连接

1. 打开设置中的 TTS 卡片，填写服务基础地址，例如 `http://127.0.0.1:9880`。不需要填写 `/tts` 或 GPU 机器上的音频路径。
2. 服务设置了密钥时，将同一密钥填入 API key。
3. 上传你有权使用的参考音频。支持 WAV、MP3、M4A、FLAC、OGG、AAC，最大 10 MiB；建议使用 3–10 秒、只有一个说话人的清晰录音。
4. 可填写参考音频中的原话。然后测试连接，再让 momo 说一句短话。中文、英语、日语分别检查；连接成功并不代替实际播放检查。

参考音频保存在 momo 自己的数据目录。合成时，桌面后端将音频作为 base64 随请求发送，GPU 服务无需访问桌面文件系统。服务为每次请求建立独立临时文件，等合成流与推理工作结束后删除；打断也会等待正在执行的工作安全退出，再释放文件。

## 当前验证范围

此部署为待验收候选，不是已发布的 GPU 发行包。

| 项目 | 状态 |
| --- | --- |
| 请求、鉴权、文件隔离、错误与取消清理 | Linux 无 GPU 契约测试已通过 |
| 固定上游合成生命周期与取消 | 使用真实上游代码、模拟模型工作已通过 |
| Docker 内 HTTP 契约 | Debian 12 / Python 3.11 测试镜像已通过 |
| 完整推理镜像、固定模型校验、中英日离线前处理 | Linux Debian 12 干净镜像已通过；不等同于 GPU 可合成 |
| 原生 Linux GPU 主机（非 WSL） | 实际合成待验证 |
| WSL2 内独立 Linux Docker Engine | RTX 3070 Laptop 上中英日实际合成、流中断清理、后续合成及容器重启恢复已通过 |
| Windows Docker Desktop | 基础 GPU 识别已通过；当前宿主启动受阻，完整部署未验收 |
| momo 桌面播放、口型、打断及真实听感 | 待验证 |

macOS 与 CPU 推理不是本部署已验证的运行方式。现有服务无需为了测试候选容器而停止；同一 GPU 上不要同时启动两套模型。

WSL 实测输出为 32 kHz 单声道 PCM16，三种语言均产生超过两秒的非静音音频；流中断及后续合成结束后，参考音临时目录均为空。测试使用独立 Linux Engine，并非 Docker Desktop 的完整部署通过。由于 Docker Hub 拉取受阻，干净镜像构建使用已校验的官方 Debian 12 最小 rootfs 覆盖默认基底；默认 digest 的直接拉取仍待验证。这些结果不代替桌面播放与听感验收。

## 部署准备

目标环境是 Linux x86_64、NVIDIA GPU、匹配 CUDA 12.4 的驱动，以及支持 GPU 容器的 Docker。Linux 需要 NVIDIA Container Toolkit；Windows 候选路径是 Docker Desktop 的 WSL2 后端。Compose 使用 NVIDIA GPU device reservation；需安装 Docker Compose v2 插件。硬件与平台支持以实际 GPU 测试结果为准。

代码固定到 GPT-SoVITS 提交 `1d9fe63d2875238bc240bd5e7b8dacaee73f8396`，默认模型为 v2。Python / CUDA 依赖及下载文件都有版本与 SHA-256 清单，不使用运行机器原来的 venv、语言缓存或 base64 补丁。资源仅在显式准备时下载，服务启动后校验并使用本地资源。

```sh
cd deploy/tts
cp .env.example .env
```

`.env` 默认绑定 `127.0.0.1:9880`。先确认该端口没有现有服务。跨机器连接优先使用 SSH 隧道或已有的 TLS 入口；需要监听受信任网络时再调整 `TTS_BIND`，并设置足够长的随机 `TTS_API_KEY`。不要把该端口直接公开到互联网。

配置项：

| 配置 | 用途 |
| --- | --- |
| `TTS_BIND` / `TTS_PORT` | 对宿主机开放的监听地址与端口，默认仅本机 |
| `TTS_API_KEY` | 可选 Bearer 密钥；启用后合成与就绪检查都需要它 |
| `TTS_IMAGE` | 本地构建的镜像标签；当前没有预先发布的镜像 |
| `TTS_BASE_IMAGE` | 固定为 Debian bookworm-slim 的 amd64 digest；覆盖它时仍须使用已验证的 digest |
| `PIP_INDEX_URL` | 构建时的 Python 包来源；锁文件校验仍强制执行 |
| `TTS_HF_ENDPOINT` | 显式准备模型时使用官方 Hugging Face 或 `https://hf-mirror.com` |

不要把 `.env`、参考录音或私人权重提交进仓库。

## 构建、准备模型、启动

```sh
docker compose build tts
docker compose --profile setup run --rm models
```

第二条命令只下载、校验和解压固定资源，不启动推理模型。默认 GPT / SoVITS、BERT、HuBERT、G2PW、NLTK、Open JTalk 与语言识别资源均由 `resources.lock.json` 列出。首次准备需要网络与磁盘空间；再次运行会检查已有文件，保留校验匹配的内容。下载失败时可以重跑，校验不匹配的文件不会被当成可用模型。

构建会离线检查固定上游 API 的实际路由注册与重采样依赖。准备完成后，可再检查真实推理模块与中英日语言资源。此检查不加载 GPU 合成模型，也不生成语音：

```sh
docker compose run --rm --no-deps --entrypoint python tts /opt/momo/smoke_inference.py
```

确认检查通过，且本次允许使用该 GPU 后再启动：

```sh
docker compose up -d tts
docker compose ps
docker compose logs --tail 80 tts
```

Compose 使用固定项目名 `momo-tts`，重复执行 `up` 更新同一服务。模型卷只读挂入推理容器，缓存使用独立持久卷；参考音与生成的流不写入这些卷。容器只开放合成、存活和就绪检查，没有训练、权重切换或管理后台。

## 检查就绪与实际音频

容器的健康检查调用 `/readyz`。`/healthz` 只说明 HTTP 进程存活；`/readyz` 仅在资源校验及 CUDA 模型加载完成后返回 200。资源缺失、校验错误或 CUDA 不可用时返回 503，并说明失败原因。`ready` 不能代替一轮真实合成。

```sh
docker compose exec -T tts python /opt/momo/check.py --ready-only
```

需要做一次实际合成时，可在拥有参考音的机器上运行仓库脚本；它只需要 Python 3 标准库。若设置了密钥，通过当前进程的 `TTS_API_KEY` 环境变量提供，与 momo 中的密钥保持一致。

```sh
python3 check.py \
  --url http://127.0.0.1:9880 \
  --reference '/path/to/reference.wav' \
  --prompt-text '参考录音中的原话' \
  --text '你好，很高兴认识你。' \
  --lang zh
```

检查会读取实际 WAV 采样率、验证单声道 PCM16、统计 PCM 长度、首个 PCM 耗时、总耗时与实时因子（总耗时 / 音频时长），并拒绝空流、格式错误和不足 0.5 秒的短输出。它默认不保存音频。需要试听产物时加 `--output /tmp/momo-tts-check.wav`；输出含生成语音，应按自己的数据管理方式保管。较短的测试词可显式调整 `--minimum-seconds`，常规检查请使用完整短句。

参考录音与目标文本语言不同时，用 `--prompt-lang` 指定录音语言，`--lang` 指定目标语言。分别以中文、英语、日语短句检查，再在 momo 中验证实际播放、字幕、口型、静音、重播、连发和打断。模型就绪与 PCM 格式正确不代表声音质量或跨平台体验已经验收。

## 常见反馈

| 反馈 | 处理 |
| --- | --- |
| `/readyz` 为 `loading` | 查看容器日志，等待资源检查与模型加载；不要额外启动另一份模型 |
| `/readyz` 为 `failed`、提示资源缺失或 checksum | 停止这个候选容器，重跑 models 准备命令，再启动 |
| CUDA unavailable | 检查宿主机驱动、容器 GPU 配置与 NVIDIA Container Toolkit；服务不会静默降级为 CPU 后宣称 ready |
| HTTP 401 | 核对服务和 momo / 检查进程中的密钥 |
| HTTP 413 | 参考音或请求过大，缩短录音并控制在 10 MiB 内 |
| HTTP 422 | 核对必填字段、语言、音频格式与 base64；只接受文件名，不接受服务端绝对路径 |
| 上游 HTTP 400 | 保留的推理反馈；检查参考音是否可解码、长度与参考文本是否合适 |
| 只有头或很短的 PCM | 合成未通过，不要当作正常可用；保留脱敏的状态与耗时，检查日志与模型资源 |

## 停止、升级与回退

```sh
docker compose stop tts
```

停止会等待正在执行的工作退出，模型与缓存卷保留。`docker compose down` 也不删除这些卷；不要使用 `down -v` 来做普通升级或重启。

升级前记录 `docker compose images` 的镜像 ID、`.env` 与当前资源清单，将旧镜像另加本地标签。使用新候选构建与准备资源后，只在允许切换 GPU 服务的时间替换容器；先完成就绪和真实短句检查，再回到 momo 验证。若新版本改变资源清单，先备份原模型卷，不能只保留镜像而丢失与它对应的权重。

回退时恢复旧镜像标签、`.env` 与匹配的模型卷，再执行 `docker compose up -d --no-build tts`。默认权重不随日常重启重新下载。不要修改、删除仍在使用的外部 GPT-SoVITS 目录来完成这一步。

部署代码、下载清单和问题修复都在 momo 维护；旧仓库、旧网站和现有运行服务的退役须在迁移与验收完成后单独执行。
