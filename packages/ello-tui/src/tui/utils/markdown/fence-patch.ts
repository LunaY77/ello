/**
 * 流式 markdown 尾部修补。
 *
 * 在词素化前补全未闭合的代码块 fence 和 inline code 反引号，
 * 让流式中的半截文本也能正确渲染。
 */
export function patchStreamingMarkdown(text: string): string {
  if (text === '') return '';
  let patched = text;
  patched = patchCodeFence(patched);
  patched = patchInlineCode(patched);
  return patched;
}

/** 检测行首 ``` 未闭合，补一个等长闭合行。 */
function patchCodeFence(text: string): string {
  const lines = text.split('\n');
  let openFence: string | undefined;
  for (const line of lines) {
    const fence = /^(`{3,})/.exec(line.trimStart());
    if (fence !== null) {
      if (openFence !== undefined) {
        // 当前行是一个闭合 fence（只有反引号，无后续内容）
        if (line.trim() === fence[1]) {
          openFence = undefined;
        }
      } else {
        // 新开一个 fence（反引号后跟语言标识或空）
        openFence = fence[1];
      }
    }
  }
  if (openFence !== undefined) {
    return `${text.endsWith('\n') ? text : `${text}\n`}${openFence}`;
  }
  return text;
}

/** 统计非 fence 行的反引号数，奇数则末尾补一个。 */
function patchInlineCode(text: string): string {
  const lines = text.split('\n');
  let inFence = false;
  for (const line of lines) {
    const fence = /^(`{3,})/.exec(line.trimStart());
    if (fence !== null) {
      if (inFence && line.trim() === fence[1]) {
        inFence = false;
      } else if (!inFence) {
        inFence = true;
      }
      continue;
    }
    if (inFence) continue;
    const count = (line.match(/`/gu) ?? []).length;
    if (count % 2 !== 0) {
      return `${text}\``;
    }
  }
  return text;
}
