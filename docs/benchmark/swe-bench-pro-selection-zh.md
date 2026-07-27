# SWE-bench Pro 30 题精选记录

## 结论

ello-bench 使用 `swe-bench-pro-calibration`：从 SWE-bench Pro OS 的 731 题中固定选择 30 题，用于 Ello 与 Claude Code 的配对对比。

上游输入固定为：

- 仓库：`https://github.com/scaleapi/SWE-bench_Pro-os.git`；
- revision：`ca10a60a5fcae51e6948ffe1485d4153d421e6c5`；
- 公开轨迹：`traj/*/eval_results.json` 中的 9 组结果；
- 任务数：30；
- task-set hash：`e14a4db17bcfd1d47ad08fa38c19caada458279db72878472eb1c0a1cbdb6083`。

## 选择原则

30 题不是简单取“最容易”或“最难”的任务，而是同时满足四个目标：

1. Python、Go、TypeScript/JavaScript 各 10 题；
2. 覆盖 easy、medium-easy、medium-hard、hard 四档；
3. 在多个仓库间分散，避免结果由单一项目主导；
4. 每道任务都能被 ello-bench 的严格 corpus 解析器完整加载。

难度档来自公开轨迹通过频次。它是经验分层，而不是任务的绝对难度：同一题在新的模型、工具或预算下可能表现不同。少数轨迹未覆盖某些任务，因此表中分母可能是 8 或 9。

## 分布

| 难度 | 题数 |
|---|---:|
| easy | 8 |
| medium-easy | 7 |
| medium-hard | 8 |
| hard | 7 |

| 语言组 | 题数 |
|---|---:|
| Python | 10 |
| Go | 10 |
| TypeScript / JavaScript | 10 |

## 完整任务表

“公开通过”表示九组上游公开轨迹中成功的次数。

| # | task ID | 项目 | 语言 | 难度 | 公开通过 |
|---:|---|---|---|---|---:|
| 1 | `swepro-ansible-0ea40e09` | ansible | Python | easy | 8/8 |
| 2 | `swepro-protonmail-f161c10c` | protonmail/webclients | TypeScript | easy | 8/8 |
| 3 | `swepro-navidrome-29b7b740` | navidrome | Go | easy | 8/9 |
| 4 | `swepro-element-ca8b1b04` | element-web | TypeScript | easy | 7/9 |
| 5 | `swepro-openlibrary-4a5d2a7d` | openlibrary | Python | easy | 7/9 |
| 6 | `swepro-vuls-e52fa8d6` | vuls | Go | medium-easy | 6/9 |
| 7 | `swepro-flipt-29d3f9db` | flipt | Go | medium-easy | 6/9 |
| 8 | `swepro-openlibrary-2abe28b4` | openlibrary | Python | medium-easy | 6/9 |
| 9 | `swepro-protonmail-01b519cd` | protonmail/webclients | TypeScript | medium-easy | 6/9 |
| 10 | `swepro-qutebrowser-fea33d60` | qutebrowser | Python | medium-easy | 5/9 |
| 11 | `swepro-ansible-d62496fe` | ansible | Python | medium-hard | 4/9 |
| 12 | `swepro-protonmail-6f8916fb` | protonmail/webclients | TypeScript | medium-hard | 4/8 |
| 13 | `swepro-element-27139ca6` | element-web | TypeScript | medium-hard | 4/9 |
| 14 | `swepro-teleport-b1bcd8b9` | teleport | Go | medium-hard | 4/8 |
| 15 | `swepro-flipt-2eac0df4` | flipt | Go | medium-hard | 4/9 |
| 16 | `swepro-nodebb-97c8569a` | NodeBB | JavaScript | hard | 3/9 |
| 17 | `swepro-qutebrowser-0b621cb0` | qutebrowser | Python | hard | 3/8 |
| 18 | `swepro-openlibrary-91efee62` | openlibrary | Python | hard | 3/8 |
| 19 | `swepro-tutanota-b4934a0f` | tutanota | TypeScript | hard | 3/9 |
| 20 | `swepro-navidrome-56303cde` | navidrome | Go | hard | 3/8 |
| 21 | `swepro-ansible-5f4e332e` | ansible | Python | easy | 8/9 |
| 22 | `swepro-qutebrowser-c580ebf0` | qutebrowser | Python | medium-easy | 5/9 |
| 23 | `swepro-openlibrary-c12943be` | openlibrary | Python | hard | 3/8 |
| 24 | `swepro-teleport-3a5c1e26` | teleport | Go | easy | 6/8 |
| 25 | `swepro-vuls-cc63a0ec` | vuls | Go | medium-hard | 4/9 |
| 26 | `swepro-navidrome-8383527a` | navidrome | Go | hard | 3/9 |
| 27 | `swepro-element-18c03daa` | element-web | TypeScript | medium-easy | 5/9 |
| 28 | `swepro-vuls-dc496468` | vuls | Go | easy | 8/9 |
| 29 | `swepro-nodebb-82562bec` | NodeBB | JavaScript | medium-hard | 4/9 |
| 30 | `swepro-tutanota-4b4e4594` | tutanota | TypeScript | medium-hard | 4/8 |

## 使用建议

首次比较可以先选 6 至 9 题做基础设施 pilot，但正式报告应运行完整 30 题：

```bash
pnpm bench:run \
  --all \
  --all-agents \
  --corpus-root ../SWE-bench_Pro-os \
  --run-root packages/ello-bench/raw/swepro-r1 \
  --report
```

如果用于外部发布，建议提高 replicate，并将任务集 hash、上游 revision、Agent 版本、配置 hash 和所有无效任务一并披露。
