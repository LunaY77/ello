# =============================================================================
# Ello Bench Makefile —— 运行、重跑、盘点 benchmark 的统一入口
# =============================================================================
#
# ## 快速开始
#
#   make                          # 列出所有命令（等于 make help）
#   make vars                     # 打印当前解析出的变量值（排查路径问题第一站）
#   make doctor                   # 环境自检（Docker / 可执行文件 / 凭据）
#   make run                      # 跑 benchmark（run root 已存在则自动只跑未完成的）
#   make status                   # 盘点某个 run root 还剩多少没跑完
#
# ## 心智模型：两个坐标
#
# 一次 benchmark 由两个东西唯一确定：
#
#   1. SUITE      —— 跑什么。决定 config 文件与 corpus cache 目录。
#   2. RUN ROOT   —— 结果写到哪。一个目录，里面是 suite-manifest.json + runs/。
#
# 所有命令都围绕这两者展开。SUITE 用预设名选择（deepswe / pro），也可以直接指定
# CONFIG 和 CORPUS 跑任意 suite。RUN ROOT 有三种指定方式，优先级从高到低：
#
#   RUN_ROOT=/abs/or/rel/path     直接给完整路径，最高优先级
#   RUN_ID=my-run-01              路径 = $(RUNS_DIR)/$(RUN_ID)
#   （都不给）                     用当前 SUITE 的默认 RUN_ID
#
# ## 重跑（resume）是怎么工作的
#
# 重跑能力在 ello-bench 内部，不在这个 Makefile 里。对**同一个 run root** 再执行
# 一次 run，每个 job 的处理方式是：
#
#   已 completed              -> 跳过，不重跑
#   非终态（被强杀留下的
#   preparing/running/
#   verifying ...）           -> 先判为 invalid_infrastructure（failure.phase =
#                                resume-interrupted-run），再开一个新 attempt
#   invalid_infrastructure    -> 直接开新 attempt
#   attempt 数 >
#   max_infrastructure_retries -> 标记 retry_exhausted，永久跳过
#
# 也就是说 `make run` 指向一个已存在的 run root 时，天然就是「只重跑没跑完的」。
# 粒度是 attempt 而不是 phase：卡在 verifier 的 attempt 不会接着验证，而是整个
# attempt 从 prepare-workspace 重来。
#
# 三个语义化入口：
#
#   make run       对目标 run root 执行；不存在就新建，存在就续跑。日常用这个。
#   make resume    同 run，但先校验 run root 已存在（防手滑打错名字新建一堆空目录）。
#   make fresh     强制全新：自动生成 <suite前缀>-<MMDD>-<序号> 的 RUN_ID，
#                  若目录已存在则报错退出，跑完自动出报告。
#
# ## 变量（全部可通过环境变量或命令行覆盖）
#
# 所有变量都用 ?= 定义，因此三种配置方式都生效，优先级从高到低：
#
#   1. 命令行：      make run RUN_ID=deep-swe-0810-01
#   2. 环境变量：    export RUNS_DIR=/mnt/ssd/bench-runs; make run
#   3. 本文件默认值
#
#   SUITE          deepswe        预设 suite 名。内置 deepswe / pro
#   CONFIG         由 SUITE 推导   benchmark config 的绝对路径
#   CORPUS         由 SUITE 推导   corpus cache 目录（任务源码快照，跨 run 复用）
#   RUNS_DIR       <bench>/raw    所有 run root 的父目录。换盘/换机器改这个
#   CACHE_DIR      <bench>/raw/_cache  corpus cache 的父目录
#   RUN_ID         由 SUITE 推导   run root 的目录名（不含路径）
#   RUN_ROOT       由上面推导      run root 完整路径，给了就一切以它为准
#   TASKS          （空）          只跑这些任务，空格分隔；空则 --all 全部任务
#   AGENTS         由 SUITE 推导   只跑这些 agent，空格分隔；空则 --all-agents
#   WITH_REPORT    0              1 表示 run 结束后顺带生成报告
#   MAX_RETRIES    从 CONFIG 读取  status 盘点用的重试上限口径
#   NODE           node           node 可执行文件。设成 echo 可干跑（见「干跑与调试」）
#
# ## agent 选择（重要）
#
# agents.toml 里目前有 6 个 agent：ello / ello-rapid / ello-ds-rapid / ello-ds /
# codex / claude-code。`--all-agents` 会把 6 个全跑，而现有的两个 run root 当初
# 只用了 3 个（ello-ds-rapid / ello-ds / claude-code），所以两个 suite 的 AGENTS
# 默认值就是这 3 个。想改就传列表：
#
#   make run AGENTS='ello-ds ello-ds-rapid claude-code'   # 显式三个（=默认）
#   make run AGENTS=claude-code                            # 只跑一个
#   make run AGENTS=                                       # 空 = --all-agents，全部 6 个
#
# 往一个**已有** run root 里加 agent 是危险操作：agent 集合决定 job 矩阵，而
# suite-manifest.json 的 jobs 数组在首次创建时就冻结了。新 agent 会凭空长出
# attempt，之后 make validate 必然报「job 不在 suite 矩阵里」。因此 make resume
# 会先比对 AGENTS 与 run root 冻结的集合，不一致就拒绝执行，并提示正确的取值。
# 真要改矩阵：换 run root（make fresh），或 ALLOW_MATRIX_CHANGE=1 强制继续。
#
# ## 常见场景
#
#   # 只重跑上次被中断的那个 run root 里没跑完的任务
#   make resume SUITE=deepswe RUN_ID=deep-swe-0809-03
#
#   # 开一个全新的 run（自动命名 deep-swe-0810-01，已存在则 -02）
#   make fresh SUITE=deepswe
#
#   # 只跑指定 agent（顺序无关，逗号不行，用空格）
#   make run SUITE=pro AGENTS='ello-ds ello-ds-rapid claude-code'
#
#   # 只跑一个任务、一个 agent，用来复现单点问题
#   make run SUITE=pro RUN_ID=debug-01 TASKS=swepro-flipt-29d3f9db AGENTS=claude-code
#
#   # 只跑两个任务的完整 agent 矩阵
#   make run TASKS='abs-stepped-slices dasel-html-document-format'
#
#   # 看某个目录下所有 run root 的进度概览
#   make runs
#
#   # 把结果写到别的盘，不动仓库
#   RUNS_DIR=/mnt/ssd/bench-runs make fresh SUITE=pro
#
#   # 跑一个仓库里没有预设的 suite
#   make run CONFIG=/abs/my-suite.toml CORPUS=/abs/cache/my-suite RUN_ID=my-01
#
#   # 两个 suite 并行（两个终端各跑一个），注意别在跑的时候执行 docker-clean
#   make resume SUITE=deepswe RUN_ID=deep-swe-0809-03     # 终端 A
#   make resume SUITE=pro RUN_ID=swe-bench-pro-0809-002   # 终端 B
#
# 每个目标还有 <suite>-<目标> 的简写形式，等价于加 SUITE= ：
#
#   make deepswe-status   ==  make status SUITE=deepswe
#   make pro-resume       ==  make resume SUITE=pro
#
# make 没有子命令概念，`make bench run` 中的 bench 只是一个空目标占位，
# 等价于 `make run`；单独 `make bench` 会打印帮助。
#
# ## 怎么读 status / runs 的输出
#
#   completed        已完成，重跑时会被跳过
#   in progress      最后一个 attempt 处于非终态：正在跑，或是被中断的残留。
#                    每条后面会打「最后活动 N 分钟前」——数字一直不变就是残留，
#                    在涨就是真的在跑。标了 [最后一次机会] 表示这个 attempt 已
#                    经是上限内的最后一次，失败后该 job 会变成 retry exhausted
#   not started      矩阵里有这个 job 但从未开始过，重跑时会正常执行
#   needs rerun      最后一个 attempt 已终态失败且还没到上限，重跑会开新 attempt
#   retry exhausted  最后一个 attempt 已终态失败且 attempt 数超过上限，重跑跳过。
#                    想让它们再跑就调大 config 里的 max_infrastructure_retries
#   unreadable       attempt 的 run.json 读不出来（目录被删或写坏），证据缺失。
#                    这一档既不是完成也不是待跑，需要人工判断
#
# 注意 retry exhausted 只对**终态**attempt 成立：ello-bench 是在决定「要不要开
# 下一个 attempt」时才比较 attempt 与上限的，所以一个正在跑的 attempt 4 不是
# 用尽，而是最后一次机会。needs rerun / retry exhausted 的分界依赖 MAX_RETRIES，
# 它默认从 CONFIG 的 max_infrastructure_retries 解析，口径与实际执行一致。
#
# ## 为什么 status 里 preparing 看起来特别多
#
# run.json 的 status 只有 4 个执行态：preparing / running / capturing /
# verifying。而 preparing 覆盖了 agent 启动之前的全部工作，其中最贵的是
# verifier-baseline-preflight（先在未改动的代码上跑一遍验证测试，实测 p50 约
# 7-8 分钟）。所以看到 preparing 不代表在等资源，多半是在跑 baseline 测试。
# 想看真实耗时分布：读 <attempt>/raw/phase-timings.json，每个 phase 都有
# durationMs。concurrency 是否吃满看 in progress 这一行，它应该接近 config 里的
# concurrency；已经吃满时再加 concurrency 只会让每个 attempt 更慢。
#
# ## 干跑与调试
#
#   make -n run                   只打印将要执行的命令，什么都不做
#   make run NODE=echo            让 CLI 调用变成 echo，用来核对完整参数拼接
#   make vars                     看变量最终解析成了什么
#   make plan                     看 job 矩阵（真实调用 CLI，但只读不写）
#
# 注意 NODE=echo 会把 resume 的 agent 集合校验也 echo 掉（它同样走 $(NODE)），
# 所以干跑看不到校验结果；真实执行时这道校验一定会跑。
#
# ## 注意事项
#
#   * run / doctor 目标都会先 make build。改了 src 不用手动记着重新构建。
#   * docker-clean 会删掉**全部** ello-bench 容器。并行跑两个 suite 时执行它会
#     杀掉另一边正在跑的容器，所以它没有被挂进任何 run 目标的依赖里。
#   * 改 config 的 execution / container 项，重跑时会立即生效；但 run root 记录的
#     configHash 仍是首次创建时的值，报告里的 provenance 会与磁盘上的 config 不符。
#     真要干净的 provenance 就用 make fresh。
#   * 千万别在 resume 之前改 agents.toml、任务集合、replicates 或 suite 的
#     source.revision —— 它们参与 jobId 计算，改了旧 attempt 全变孤儿，validate
#     还会因为 job 不在冻结的 suite.jobs 里而报错。AGENTS 集合同理，见「agent
#     选择」一节，resume 已经内建了这道校验。
#   * SWE-bench Pro 的 ProtonMail/Alpine 类任务会在 prepare-agent 失败：musl 容器
#     执行不了宿主机的 glibc Node/Claude 二进制。这是独立的运行时兼容问题，重跑
#     不会让它们通过。
#
# =============================================================================

# --- 路径基准（用 MAKEFILE_LIST 定位仓库根，因此在任何 cwd 下 make -f 都正确） ---
REPO_ROOT := $(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))
BENCH := $(REPO_ROOT)/packages/ello-bench

NODE ?= node
CLI := $(NODE) $(BENCH)/dist/cli.js
STATUS := $(NODE) $(BENCH)/scripts/run-status.mjs
CHECK_AGENTS := $(NODE) $(BENCH)/scripts/check-agent-selection.mjs

RUNS_DIR ?= $(BENCH)/raw
CACHE_DIR ?= $(BENCH)/raw/_cache

# --- suite 预设 ---------------------------------------------------------------
# 新增一个 suite：照下面几行加 SUITE_<名字>_{CONFIG,CORPUS,RUN_ID,PREFIX,AGENTS} 即可，
# 其余所有目标无需改动。PREFIX 用于 make fresh 自动命名。
SUITE ?= deepswe

SUITE_deepswe_CONFIG := $(BENCH)/config/benchmark.toml
SUITE_deepswe_CORPUS := $(CACHE_DIR)/deep-swe-v1.1
SUITE_deepswe_RUN_ID := deep-swe-0809-03
SUITE_deepswe_PREFIX := deep-swe
SUITE_deepswe_AGENTS := ello-ds-rapid ello-ds claude-code

SUITE_pro_CONFIG := $(BENCH)/config/swe-bench-pro.toml
SUITE_pro_CORPUS := $(CACHE_DIR)/swe-bench-pro
SUITE_pro_RUN_ID := swe-bench-pro-0809-002
SUITE_pro_PREFIX := swe-bench-pro
SUITE_pro_AGENTS := ello-ds-rapid ello-ds claude-code

# --- 由 SUITE 推导，可被逐项覆盖 ---------------------------------------------
CONFIG ?= $(SUITE_$(SUITE)_CONFIG)
CORPUS ?= $(SUITE_$(SUITE)_CORPUS)
RUN_ID ?= $(SUITE_$(SUITE)_RUN_ID)
PREFIX ?= $(or $(SUITE_$(SUITE)_PREFIX),$(SUITE))
RUN_ROOT ?= $(RUNS_DIR)/$(RUN_ID)

# 从 config 里读重试上限，保证 status 的口径和实际执行一致；读不到退回 1
MAX_RETRIES ?= $(or $(shell sed -n 's/^max_infrastructure_retries[[:space:]]*=[[:space:]]*\([0-9]\+\).*/\1/p' $(CONFIG) 2>/dev/null),1)

# 任务/agent 选择：空格分隔的列表，--task/--agent 都可以重复传。
# TASKS 留空 = --all（全部任务）。
# AGENTS 留空 = --all-agents（config 里的全部 agent，当前是 6 个），
# 因此这里默认给到 suite 预设的 3 个，避免不小心把没在跑的 agent 拉进矩阵。
TASKS ?=
AGENTS ?= $(SUITE_$(SUITE)_AGENTS)
SELECT := $(if $(TASKS),$(foreach task,$(TASKS),--task $(task)),--all) \
	$(if $(AGENTS),$(foreach agent,$(AGENTS),--agent $(agent)),--all-agents)
WITH_REPORT ?= 0
REPORT_FLAG := $(if $(filter-out 0,$(WITH_REPORT)),--report,)

.DEFAULT_GOAL := help
# 前置校验目标必须严格先于执行目标跑完（-j 下并行会让校验失去意义），
# 而且这里没有任何目标能从并行构建中获益：benchmark 的并发在 CLI 内部。
.NOTPARALLEL:
.PHONY: help vars bench build test typecheck lint verify \
	list agents plan doctor config-print \
	run resume fresh status runs report validate \
	docker-clean docker-ps \
	_require-suite _require-existing-root _require-matching-agents

# =============================================================================
# 元命令
# =============================================================================

help: ## 列出所有命令（默认目标）
	@echo 'Ello Bench —— 用法：make <目标> [变量=值 ...]'
	@echo ''
	@echo '目标：'
	@grep -hE '^[a-z][a-z-]*:.*?##' $(MAKEFILE_LIST) \
		| sed -e 's/:[^#]*##/\t/' \
		| awk -F'\t' '{ printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2 }'
	@echo ''
	@echo '常用变量：SUITE RUN_ID RUN_ROOT RUNS_DIR CONFIG CORPUS TASKS AGENTS WITH_REPORT'
	@echo '简写：make <suite>-<目标>，例如 make pro-status 等价于 make status SUITE=pro'
	@echo '详细说明见本文件顶部注释：less $(firstword $(MAKEFILE_LIST))'

vars: ## 打印当前解析出的变量值（排查路径问题先看这个）
	@echo 'SUITE        $(SUITE)'
	@echo 'CONFIG       $(CONFIG)'
	@echo 'CORPUS       $(CORPUS)'
	@echo 'RUNS_DIR     $(RUNS_DIR)'
	@echo 'RUN_ID       $(RUN_ID)'
	@echo 'RUN_ROOT     $(RUN_ROOT)'
	@echo 'TASKS        $(if $(TASKS),$(TASKS),(全部))'
	@echo 'AGENTS       $(if $(AGENTS),$(AGENTS),(全部))'
	@echo 'MAX_RETRIES  $(MAX_RETRIES)'
	@echo 'SELECT       $(SELECT)'
	@echo 'WITH_REPORT  $(WITH_REPORT)'
	@echo 'CLI          $(CLI)'

bench: ## 命名空间占位：make bench run 等价于 make run
ifeq ($(MAKECMDGOALS),bench)
	@$(MAKE) --no-print-directory help
else
	@:
endif

# 校验 SUITE 能解析出 config；给出可用预设列表而不是让 CLI 报一个费解的错
_require-suite:
	@if [ -z '$(CONFIG)' ]; then \
		echo 'error: 未知 SUITE=$(SUITE)，也没有显式传 CONFIG=' >&2; \
		echo '可用预设：$(patsubst SUITE_%_CONFIG,%,$(filter SUITE_%_CONFIG,$(.VARIABLES)))' >&2; \
		echo '或者：make run CONFIG=/abs/suite.toml CORPUS=/abs/cache/suite RUN_ID=my-01' >&2; \
		exit 2; \
	fi
	@if [ ! -f '$(CONFIG)' ]; then echo 'error: config 不存在：$(CONFIG)' >&2; exit 2; fi

_require-existing-root:
	@if [ ! -f '$(RUN_ROOT)/suite-manifest.json' ]; then \
		echo 'error: run root 不存在或未初始化：$(RUN_ROOT)' >&2; \
		echo '现有 run root（make runs 看详情）：' >&2; \
		ls -1 '$(RUNS_DIR)' 2>/dev/null | grep -v '^_' | sed 's/^/  /' >&2 || true; \
		echo '要新建请用：make fresh SUITE=$(SUITE)' >&2; \
		exit 2; \
	fi

# resume 前校验 agent 集合与 run root 冻结下来的一致。
# 往一个已有 run root 里塞新 agent 会凭空长出 job，而 suite-manifest.json 的
# jobs 数组是首次创建时冻结的，之后 validate 会报「job 不在 suite 矩阵里」。
# 确实要改矩阵就换 run root（make fresh），或显式 ALLOW_MATRIX_CHANGE=1 跳过。
_require-matching-agents:
	@if [ '$(ALLOW_MATRIX_CHANGE)' = '1' ]; then \
		echo 'warning: 已跳过 agent 集合校验（ALLOW_MATRIX_CHANGE=1）' >&2; \
	else \
		$(CHECK_AGENTS) '$(RUN_ROOT)' '$(AGENTS)'; \
	fi

# =============================================================================
# 构建与校验
# =============================================================================

build: ## 构建 @ello/bench（run / doctor 已自动依赖它）
	cd $(REPO_ROOT) && pnpm --filter @ello/bench build

test: ## 跑 @ello/bench 单元测试
	cd $(REPO_ROOT) && pnpm --filter @ello/bench test

typecheck: ## tsc --noEmit
	cd $(REPO_ROOT) && pnpm --filter @ello/bench typecheck

lint: ## eslint src + tests
	cd $(REPO_ROOT) && pnpm exec eslint packages/ello-bench/src packages/ello-bench/tests

verify: test typecheck lint ## test + typecheck + lint 一把过

# =============================================================================
# 只读查询（不碰容器、不写 run root）
# =============================================================================

list: _require-suite ## 列出当前 suite 的任务清单
	@$(CLI) list --config $(CONFIG)

agents: _require-suite ## 列出当前 suite 可用的 agent
	@$(CLI) agents --config $(CONFIG)

plan: _require-suite ## 打印将要执行的 job 矩阵（不执行）
	@$(CLI) plan $(SELECT) --config $(CONFIG)

config-print: _require-suite ## 打印解析后的完整 config
	@$(CLI) config print --resolved --config $(CONFIG)

status: _require-suite ## 盘点单个 run root：已完成 / 待重跑 / 已耗尽重试
	@$(STATUS) $(RUN_ROOT) --max-retries $(MAX_RETRIES)

runs: _require-suite ## 一行一个，列出 RUNS_DIR 下所有 run root 的进度概览
	@found=0; \
	for dir in $(RUNS_DIR)/*/; do \
		[ -f "$$dir/suite-manifest.json" ] || continue; \
		found=1; \
		$(STATUS) "$$dir" --brief --max-retries $(MAX_RETRIES); \
	done; \
	[ "$$found" = 1 ] || echo 'no run root under $(RUNS_DIR)'

validate: ## 校验 run root 的证据完整性（configHash / job 矩阵 / 产物）
	@$(CLI) validate --run-root $(RUN_ROOT)

report: ## 生成 run root 的报告
	$(CLI) report --run-root $(RUN_ROOT)

# =============================================================================
# 执行
# =============================================================================

doctor: _require-suite build ## 环境自检：Docker、可执行文件、凭据
	$(CLI) doctor --all-agents --config $(CONFIG)

run: _require-suite build ## 执行 benchmark；run root 已存在则只跑未完成的
	@echo '>>> suite=$(SUITE) run-root=$(RUN_ROOT) select=$(SELECT)'
	$(CLI) run $(SELECT) --run-root $(RUN_ROOT) \
		--corpus-root $(CORPUS) --config $(CONFIG) $(REPORT_FLAG)
	@$(STATUS) $(RUN_ROOT) --max-retries $(MAX_RETRIES)

resume: _require-existing-root _require-matching-agents run ## 只重跑未完成的任务（要求 run root 已存在）

fresh: _require-suite build ## 全新 run：自动生成 <前缀>-<MMDD>-<序号> 并生成报告
	@set -e; \
	root='$(if $(filter-out $(RUNS_DIR)/$(SUITE_$(SUITE)_RUN_ID),$(RUN_ROOT)),$(RUN_ROOT),)'; \
	if [ -z "$$root" ]; then \
		stamp=$$(date +%m%d); seq=1; \
		while :; do \
			candidate='$(RUNS_DIR)'/'$(PREFIX)'-$$stamp-$$(printf '%02d' $$seq); \
			[ -e "$$candidate" ] || break; \
			seq=$$((seq + 1)); \
		done; \
		root=$$candidate; \
	fi; \
	if [ -e "$$root" ]; then echo "error: run root 已存在，fresh 拒绝复用：$$root" >&2; exit 2; fi; \
	echo ">>> suite=$(SUITE) fresh run-root=$$root select=$(SELECT)"; \
	$(CLI) run $(SELECT) --run-root "$$root" \
		--corpus-root $(CORPUS) --config $(CONFIG) --report; \
	$(STATUS) "$$root" --max-retries $(MAX_RETRIES)

# =============================================================================
# 容器维护
# =============================================================================

docker-ps: ## 查看当前所有 ello-bench 容器
	@docker ps -a --filter 'name=^ello-bench-' --format '{{.Names}}\t{{.Status}}'

docker-clean: ## 删除全部 ello-bench 容器（并行跑多个 suite 时勿用）
	@names=$$(docker ps -aq --filter 'name=^ello-bench-'); \
	if [ -n "$$names" ]; then docker rm -f $$names; else echo 'no ello-bench containers'; fi

# =============================================================================
# 简写：make <suite>-<目标> == make <目标> SUITE=<suite>
# 例：make pro-status / make deepswe-resume / make pro-fresh
# 依赖 pattern rule，因此不要在仓库根创建名为 deepswe-* 或 pro-* 的文件。
# =============================================================================

deepswe-%:
	@$(MAKE) --no-print-directory $* SUITE=deepswe

pro-%:
	@$(MAKE) --no-print-directory $* SUITE=pro
