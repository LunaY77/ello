import { Box, Text } from 'ink';
import { useEffect, useRef, useState } from 'react';

import type { UserInputResolution } from '../../api/protocol-types.js';
import type { UserInputRequest } from '../store/history-entry.js';
import { useTheme } from '../theme/index.js';
import { InlineSelect } from '../ui/List.js';

import { Composer } from './Composer.js';

export function UserInputPanel({
  pending,
  onResolve,
}: {
  readonly pending: UserInputRequest;
  onResolve(resolution: UserInputResolution): Promise<void>;
}) {
  const theme = useTheme();
  const [questionIndex, setQuestionIndex] = useState(0);
  const [answers, setAnswers] = useState<
    Array<{
      questionId: string;
      selected: string[];
      otherText?: string;
    }>
  >([]);
  const [multiSelection, setMultiSelection] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [mode, setMode] = useState<'question' | 'other' | 'review' | 'chat'>(
    'question',
  );
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();
  const completingQuestion = useRef(false);
  const resolving = useRef(false);
  const question = pending.params.questions[questionIndex];

  useEffect(() => {
    completingQuestion.current = false;
  }, [questionIndex]);

  const completeQuestion = (selected: string[], otherText?: string): void => {
    if (question === undefined || completingQuestion.current) return;
    completingQuestion.current = true;
    setAnswers((current) => [
      ...current,
      {
        questionId: question.id,
        selected,
        ...(otherText !== undefined ? { otherText } : {}),
      },
    ]);
    setMultiSelection(new Set());
    setText('');
    if (questionIndex + 1 === pending.params.questions.length) {
      setMode('review');
    } else {
      setQuestionIndex((current) => current + 1);
      setMode('question');
    }
  };

  const resolve = (resolution: UserInputResolution): void => {
    if (resolving.current) return;
    resolving.current = true;
    setError(undefined);
    void onResolve(resolution).catch((caught) => {
      resolving.current = false;
      setError(caught instanceof Error ? caught.message : String(caught));
    });
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={1}
    >
      <Text color={theme.accent}>Awaiting your input</Text>
      {mode === 'question' && question !== undefined ? (
        <Box flexDirection="column">
          <Text
            color={theme.textMuted}
          >{`${questionIndex + 1}/${pending.params.questions.length} ${question.header}`}</Text>
          <Text color={theme.text}>{question.question}</Text>
          <InlineSelect
            key={`question-${question.id}`}
            options={[
              ...question.options.map((option, index) => ({
                value: option.label,
                label: `${option.label}${index === 0 ? ' (Recommended)' : ''} — ${option.description}`,
              })),
              { value: 'Other', label: 'Other...' },
            ]}
            multiple={question.multiple}
            selectedValues={multiSelection}
            onToggle={(value) => {
              const next = new Set(multiSelection);
              if (next.has(value)) next.delete(value);
              else next.add(value);
              setMultiSelection(next);
            }}
            onSubmit={() => {
              if (multiSelection.size === 0) {
                setError('Select at least one option.');
              } else if (multiSelection.has('Other')) {
                setMode('other');
              } else {
                completeQuestion([...multiSelection]);
              }
            }}
            onChange={(value) => {
              if (value === 'Other') setMode('other');
              else completeQuestion([value]);
            }}
          />
          {question.multiple ? (
            <Text color={theme.textMuted}>Space toggles, Enter confirms</Text>
          ) : null}
        </Box>
      ) : null}
      {mode === 'other' ? (
        <Box flexDirection="column">
          <Text color={theme.text}>Describe your answer</Text>
          <Composer
            running={false}
            value={text}
            onChange={setText}
            onSubmit={(value) => {
              const trimmed = value.trim();
              if (trimmed === '') {
                setError('Other text cannot be empty.');
                return;
              }
              completeQuestion(
                question?.multiple
                  ? [...new Set([...multiSelection, 'Other'])]
                  : ['Other'],
                trimmed,
              );
            }}
            onCancel={() => setMode('question')}
            onEscape={() => setMode('question')}
          />
        </Box>
      ) : null}
      {mode === 'review' ? (
        <Box flexDirection="column">
          <Text color={theme.text}>Review</Text>
          {answers.map((answer) => (
            <Text key={answer.questionId} color={theme.textMuted}>
              {`${answer.questionId}: ${answer.selected
                .map((value) =>
                  value === 'Other' ? (answer.otherText ?? value) : value,
                )
                .join(', ')}`}
            </Text>
          ))}
          <InlineSelect
            key="review-actions"
            options={[
              { value: 'submit', label: 'Submit' },
              { value: 'chat', label: 'Chat about this' },
              { value: 'deny', label: 'Deny' },
            ]}
            onChange={(value) => {
              if (value === 'submit') {
                resolve({ status: 'submitted', answers });
              } else if (value === 'chat') {
                setText('');
                setMode('chat');
              } else {
                resolve({ status: 'denied' });
              }
            }}
          />
        </Box>
      ) : null}
      {mode === 'chat' ? (
        <Box flexDirection="column">
          <Text color={theme.text}>Chat about this</Text>
          <Composer
            running={false}
            value={text}
            onChange={setText}
            onSubmit={(value) => {
              const message = value.trim();
              if (message === '') setError('Message cannot be empty.');
              else resolve({ status: 'chat', message });
            }}
            onCancel={() => setMode('review')}
            onEscape={() => setMode('review')}
          />
        </Box>
      ) : null}
      {error !== undefined ? <Text color={theme.error}>{error}</Text> : null}
    </Box>
  );
}
