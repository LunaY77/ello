import type { ServerRequestParams } from '@ello/agent/protocol';
import { MessagesSquare } from 'lucide-react';
import { useState } from 'react';


import { respondUserInput } from '../approval';

import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import { runOperation } from '@/lib/report';
import type { PendingRequestEntry } from '@/store/types';


type Questions = ServerRequestParams<'item/tool/requestUserInput'>['questions'];

/**
 * 工具追问卡:结构化选择题(单选/多选)+ 提交 / 转为对话 / 拒绝。
 * 转为对话把用户的话作为追问回复,ello 会继续对话而不是执行。
 */
export function UserInputCard(props: { readonly entry: PendingRequestEntry }) {
  const { entry } = props;
  const params = entry.params as ServerRequestParams<'item/tool/requestUserInput'>;
  const questions: Questions = params.questions;
  const [selections, setSelections] = useState<Readonly<Record<string, readonly string[]>>>({});
  const [chatMode, setChatMode] = useState(false);
  const [chatText, setChatText] = useState('');
  const responding = entry.state === 'responding';

  const toggleOption = (questionId: string, label: string, multiple: boolean) => {
    const current = selections[questionId] ?? [];
    const next = multiple
      ? current.includes(label)
        ? current.filter((item) => item !== label)
        : [...current, label]
      : [label];
    setSelections({ ...selections, [questionId]: next });
  };

  const complete = questions.every(
    (question) => (selections[question.id] ?? []).length > 0,
  );

  const submit = () =>
    void runOperation(
      respondUserInput(entry.id, {
        status: 'submitted',
        answers: questions.map((question) => ({
          questionId: question.id,
          selected: selections[question.id] ?? [],
        })),
      }),
    );

  return (
    <div className="overflow-hidden rounded-xl border border-card-border bg-elevated shadow-3">
      <div className="flex items-center gap-2 px-4 pt-3 pb-2">
        <MessagesSquare size={15} className="text-tertiary" />
        <span className="text-[13px] font-semibold text-primary">ello 在问你</span>
      </div>

      <div className="flex max-h-72 flex-col gap-4 overflow-y-auto px-4 pb-3">
        {questions.map((question) => (
          <div key={question.id}>
            <div className="text-[12px] font-medium text-tertiary">{question.header}</div>
            <div className="mt-0.5 text-[13px] text-primary">{question.question}</div>
            <div className="mt-2 flex flex-col gap-1">
              {question.options.map((option) => {
                const selected = (selections[question.id] ?? []).includes(option.label);
                return (
                  <button
                    key={option.label}
                    type="button"
                    onClick={() => toggleOption(question.id, option.label, question.multiple)}
                    className={cn(
                      'flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors duration-150',
                      selected
                        ? 'border-card-border-accent bg-fluent-subtle'
                        : 'border-border-subtle hover:bg-surface-2',
                    )}
                  >
                    <span
                      className={cn(
                        'mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center border',
                        question.multiple ? 'rounded-[3px]' : 'rounded-full',
                        selected ? 'border-fluent bg-fluent' : 'border-border-strong',
                      )}
                    >
                      {selected && <span className="h-1.5 w-1.5 rounded-full bg-on-accent" />}
                    </span>
                    <span>
                      <span className="block text-[12.5px] text-primary">{option.label}</span>
                      {option.description !== '' && (
                        <span className="block text-[11.5px] text-tertiary">
                          {option.description}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {chatMode && (
          <textarea
            value={chatText}
            onChange={(event) => setChatText(event.target.value)}
            placeholder="直接回复 ello,而不是选择上面的选项…"
            rows={2}
            autoFocus
            className="w-full resize-none rounded-lg border border-border-default bg-surface-1 px-3 py-2 text-[13px] outline-none placeholder:text-disabled focus:border-card-border-accent"
          />
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-border-subtle px-4 py-2.5">
        <button
          type="button"
          disabled={responding}
          onClick={() => void runOperation(respondUserInput(entry.id, { status: 'denied' }))}
          className="cursor-pointer text-[12px] text-tertiary hover:text-danger"
        >
          拒绝回答
        </button>
        <div className="flex-1" />
        <Button
          variant="secondary"
          size="sm"
          disabled={responding}
          onClick={() => {
            if (chatMode && chatText.trim() !== '') {
              void runOperation(
                respondUserInput(entry.id, { status: 'chat', message: chatText.trim() }),
              );
              return;
            }
            setChatMode((v) => !v);
          }}
        >
          {chatMode ? '发送回复' : '转为对话'}
        </Button>
        {!chatMode && (
          <Button variant="primary" size="sm" disabled={!complete || responding} onClick={submit}>
            提交
          </Button>
        )}
      </div>
    </div>
  );
}
