# codexlog

`codexlog` 是一个用于清理本机 Codex 聊天记录的小型命令行工具。 `提供一键彻底删除全部记录功能，Codex CLI彻底变干净，Codex Desktop也会变干净但是否有其他影响未知，如果是Codex Desktop请谨慎使用彻底删除。`

## 为什么做这个工具

Codex 目前没有提供真正删除本地聊天记录、Logs、Sessions的功能。用户在界面里归档某些对话后，这些记录看起来消失了，但实际上更多是被隐藏起来，本地仍然可能保留对应的 session、日志和相关数据。

如果你只是想清理一些不再需要的 Codex 对话，可能根本无从下手。`codexlog` 的目标就是把这件事做成一个简单的终端工具：打开、选择、确认、清理。

## 主要功能

- 在终端中列出本机 Codex 的聊天记录。
- 支持交互式选择要清理的记录。
- 支持一次选择多条记录。
- 删除前会二次确认，避免误操作。
- 会尽量清理所选记录相关的本地数据。
- 支持清理由目标对话派生出的相关 session。
- 支持 macOS、Linux、Windows。

## 安装

使用 npm 全局安装：

```sh
npm install -g codexlog
```

安装完成后，在终端输入：

```sh
codexlog
```

查看帮助：

```sh
codexlog --help
```

## 使用方法

运行：

```sh
codexlog
```

进入界面后，可以使用键盘操作：

| 按键 | 作用 |
| --- | --- |
| `↑` / `↓` | 上下移动 |
| `k` / `j` | 上下移动 |
| `D` | 选择或取消选择当前记录 |
| `Enter` | 删除已选择的记录 |
| `q` / `Esc` | 退出 |

删除流程：

1. 运行 `codexlog`
2. 移动到想清理的记录
3. 按 `D` 选中
4. 可以继续选择其他记录
5. 按 `Enter`
6. 输入 `y` 确认删除

如果不想删除，按 `q` 或 `Esc` 退出即可。

## 重要提醒

清理前请先退出 Codex CLI、Codex Desktop、Codex扩展。

如果 Codex 仍在运行，它可能正在写入或锁定本地数据。为了避免数据正在写入、锁定或状态未同步的情况，请先关闭正在运行的 Codex，再执行：

```sh
codexlog
```

## 自定义数据目录

一般情况下直接运行 `codexlog` 即可。

如果你想在测试目录中试用，可以通过 `CODEX_ROOT` 指定目录。

macOS / Linux：

```sh
CODEX_ROOT=/path/to/test-codex codexlog
```

Windows PowerShell：

```powershell
$env:CODEX_ROOT="C:\path\to\test-codex"
codexlog
```

## 从源码运行

克隆项目：

```sh
git clone https://github.com/leebufan/codexlog.git
cd codexlog
```

安装依赖：

```sh
npm install
```

本地运行：

```sh
node bin/codexlog.js
```

运行测试：

```sh
npm test
```

## 环境要求

- Node.js `>=20`
- npm

## 版本

这是一个测试性质的小工具，后续可能会根据 Codex 的变化继续调整。

## License

MIT
