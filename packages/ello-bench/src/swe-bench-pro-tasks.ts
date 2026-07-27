import type { SweBenchProTaskDeclaration, TaskLanguage } from './contracts.js';
import { sha256, stableJson } from './hash.js';

export const SWE_BENCH_PRO_SOURCE_REVISION =
  'ca10a60a5fcae51e6948ffe1485d4153d421e6c5';
export const SWE_BENCH_PRO_SOURCE_REPOSITORY =
  'https://github.com/scaleapi/SWE-bench_Pro-os.git';

function task(
  taskId: string,
  instanceId: string,
  language: TaskLanguage,
  difficultyBand: SweBenchProTaskDeclaration['difficultyBand'],
): SweBenchProTaskDeclaration {
  return { taskId, instanceId, language, difficultyBand };
}

/**
 * 这组三十题用于 Agent 优化闭环，不代表完整 SWE-bench Pro 排行榜。
 * 分层依据是上游仓库九组公开轨迹在固定 revision 上的通过频次。
 */
export const SWE_BENCH_PRO_TASKS: ReadonlyArray<SweBenchProTaskDeclaration> = [
  task(
    'swepro-ansible-0ea40e09',
    'instance_ansible__ansible-0ea40e09d1b35bcb69ff4d9cecf3d0defa4b36e8-v30a923fb5c164d6cd18280c02422f75e611e8fb2',
    'python',
    'easy',
  ),
  task(
    'swepro-protonmail-f161c10c',
    'instance_protonmail__webclients-f161c10cf7d31abf82e8d64d7a99c9fac5acfa18',
    'typescript',
    'easy',
  ),
  task(
    'swepro-navidrome-29b7b740',
    'instance_navidrome__navidrome-29b7b740ce469201af0a0510f3024adc93ef4c8e',
    'go',
    'easy',
  ),
  task(
    'swepro-element-ca8b1b04',
    'instance_element-hq__element-web-ca8b1b04effb4fec0e1dd3de8e3198eeb364d50e-vnan',
    'typescript',
    'easy',
  ),
  task(
    'swepro-openlibrary-4a5d2a7d',
    'instance_internetarchive__openlibrary-4a5d2a7d24c9e4c11d3069220c0685b736d5ecde-v13642507b4fc1f8d234172bf8129942da2c2ca26',
    'python',
    'easy',
  ),
  task(
    'swepro-vuls-e52fa8d6',
    'instance_future-architect__vuls-e52fa8d6ed1d23e36f2a86e5d3efe9aa057a1b0d',
    'go',
    'medium-easy',
  ),
  task(
    'swepro-flipt-29d3f9db',
    'instance_flipt-io__flipt-29d3f9db40c83434d0e3cc082af8baec64c391a9',
    'go',
    'medium-easy',
  ),
  task(
    'swepro-openlibrary-2abe28b4',
    'instance_internetarchive__openlibrary-2abe28b472ffed563a87cfe83685b161b35263b0-v13642507b4fc1f8d234172bf8129942da2c2ca26',
    'python',
    'medium-easy',
  ),
  task(
    'swepro-protonmail-01b519cd',
    'instance_protonmail__webclients-01b519cd49e6a24d9a05d2eb97f54e420740072e',
    'typescript',
    'medium-easy',
  ),
  task(
    'swepro-qutebrowser-fea33d60',
    'instance_qutebrowser__qutebrowser-fea33d607fde83cf505b228238cf365936437a63-v9f8e9d96c85c85a605e382f1510bd08563afc566',
    'python',
    'medium-easy',
  ),
  task(
    'swepro-ansible-d62496fe',
    'instance_ansible__ansible-d62496fe416623e88b90139dc7917080cb04ce70-v0f01c69f1e2528b935359cfe578530722bca2c59',
    'python',
    'medium-hard',
  ),
  task(
    'swepro-protonmail-6f8916fb',
    'instance_protonmail__webclients-6f8916fbadf1d1f4a26640f53b5cf7f55e8bedb7',
    'typescript',
    'medium-hard',
  ),
  task(
    'swepro-element-27139ca6',
    'instance_element-hq__element-web-27139ca68eb075a4438c18fca184887002a4ffbc-vnan',
    'typescript',
    'medium-hard',
  ),
  task(
    'swepro-teleport-b1bcd8b9',
    'instance_gravitational__teleport-b1bcd8b90c474a35bb11cc3ef4cc8941e1f8eab2-vee9b09fb20c43af7e520f57e9239bbcf46b7113d',
    'go',
    'medium-hard',
  ),
  task(
    'swepro-flipt-2eac0df4',
    'instance_flipt-io__flipt-2eac0df47b5ecc8bb05002d80383ceb08ab3620a',
    'go',
    'medium-hard',
  ),
  task(
    'swepro-nodebb-97c8569a',
    'instance_NodeBB__NodeBB-97c8569a798075c50e93e585ac741ab55cb7c28b-vf2cf3cbd463b7ad942381f1c6d077626485a1e9e',
    'javascript',
    'hard',
  ),
  task(
    'swepro-qutebrowser-0b621cb0',
    'instance_qutebrowser__qutebrowser-0b621cb0ce2b54d3f93d8d41d8ff4257888a87e5-v2ef375ac784985212b1805e1d0431dc8f1b3c171',
    'python',
    'hard',
  ),
  task(
    'swepro-openlibrary-91efee62',
    'instance_internetarchive__openlibrary-91efee627df01e32007abf2d6ebf73f9d9053076-vbee42ad1b72fb23c6a1c874868a720b370983ed2',
    'python',
    'hard',
  ),
  task(
    'swepro-tutanota-b4934a0f',
    'instance_tutao__tutanota-b4934a0f3c34d9d7649e944b183137e8fad3e859-vbc0d9ba8f0071fbe982809910959a6ff8884dbbf',
    'typescript',
    'hard',
  ),
  task(
    'swepro-navidrome-56303cde',
    'instance_navidrome__navidrome-56303cde23a4122d2447cbb266f942601a78d7e4',
    'go',
    'hard',
  ),
  task(
    'swepro-ansible-5f4e332e',
    'instance_ansible__ansible-5f4e332e3762999d94af27746db29ff1729252c1-v0f01c69f1e2528b935359cfe578530722bca2c59',
    'python',
    'easy',
  ),
  task(
    'swepro-qutebrowser-c580ebf0',
    'instance_qutebrowser__qutebrowser-c580ebf0801e5a3ecabc54f327498bb753c6d5f2-v2ef375ac784985212b1805e1d0431dc8f1b3c171',
    'python',
    'medium-easy',
  ),
  task(
    'swepro-openlibrary-c12943be',
    'instance_internetarchive__openlibrary-c12943be1db80cf1114bc267ddf4f9933aca9b28-v2c55207218fb8a0138425cbf7d9675272e240b90',
    'python',
    'hard',
  ),
  task(
    'swepro-teleport-3a5c1e26',
    'instance_gravitational__teleport-3a5c1e26394df2cb4fb3f01147fb9979662972c5-vee9b09fb20c43af7e520f57e9239bbcf46b7113d',
    'go',
    'easy',
  ),
  task(
    'swepro-vuls-cc63a0ec',
    'instance_future-architect__vuls-cc63a0eccfdd318e67c0a6edeffc7bf09b6025c0',
    'go',
    'medium-hard',
  ),
  task(
    'swepro-navidrome-8383527a',
    'instance_navidrome__navidrome-8383527aaba1ae8fa9765e995a71a86c129ef626',
    'go',
    'hard',
  ),
  task(
    'swepro-element-18c03daa',
    'instance_element-hq__element-web-18c03daa865d3c5b10e52b669cd50be34c67b2e5-vnan',
    'typescript',
    'medium-easy',
  ),
  task(
    'swepro-vuls-dc496468',
    'instance_future-architect__vuls-dc496468b9e9fb73371f9606cdcdb0f8e12e70ca',
    'go',
    'easy',
  ),
  task(
    'swepro-nodebb-82562bec',
    'instance_NodeBB__NodeBB-82562bec444940608052f3e4149e0c61ec80bf3f-vd59a5728dfc977f44533186ace531248c2917516',
    'javascript',
    'medium-hard',
  ),
  task(
    'swepro-tutanota-4b4e4594',
    'instance_tutao__tutanota-4b4e45949096bb288f2b522f657610e480efa3e8-vee878bb72091875e912c52fc32bc60ec3760227b',
    'typescript',
    'medium-hard',
  ),
];

export const SWE_BENCH_PRO_TASK_SET_HASH = sha256(
  stableJson(SWE_BENCH_PRO_TASKS),
);

if (SWE_BENCH_PRO_TASKS.length !== 30) {
  throw new Error(
    `Expected 30 SWE-bench Pro tasks, received ${SWE_BENCH_PRO_TASKS.length}.`,
  );
}
