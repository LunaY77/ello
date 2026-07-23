import { Check, Copy } from 'lucide-react';
import {
  isValidElement,
  memo,
  useMemo,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { highlightCode } from './highlight';

import { cn } from '@/lib/cn';
import { openExternal } from '@/lib/tauri/bridge';


/** Agent 消息的 Markdown 渲染:GFM 全量,代码块三段式(顶栏/内容/状态)。 */
export const Markdown = memo(function Markdown(props: {
  readonly text: string;
  readonly streaming?: boolean | undefined;
}) {
  const { text, streaming = false } = props;
  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
      {streaming && (
        <span className="animate-pulse-soft ml-0.5 inline-block h-4 w-2 translate-y-0.5 rounded-[1px] bg-fluent" />
      )}
    </div>
  );
});

function Anchor({ href, children, ...rest }: ComponentProps<'a'>) {
  return (
    <a
      href={href}
      className="text-fluent underline decoration-fluent/40 underline-offset-2 hover:decoration-fluent"
      onClick={(event) => {
        if (href === undefined) return;
        event.preventDefault();
        void openExternal(href);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}

function InlineCode(props: ComponentProps<'code'>) {
  const { node: _node, ...rest } = props as ComponentProps<'code'> & {
    readonly node?: unknown;
  };
  return (
    <code
      className="rounded border border-border-subtle bg-surface-2 px-1 py-0.5 font-mono text-[0.86em] text-primary"
      {...rest}
    />
  );
}

/** 代码块在 hast 中始终是 pre>code;从 code 子元素提取语言与源码。 */
function Pre(props: ComponentProps<'pre'>) {
  const { children } = props;
  if (isValidElement<{ className?: string | undefined; children?: ReactNode }>(children)) {
    const className = children.props.className ?? '';
    const lang = /language-(\w+)/.exec(className)?.[1];
    const text = extractText(children.props.children).replace(/\n$/, '');
    return <CodeBlock language={lang} code={text} />;
  }
  return <pre>{children}</pre>;
}

function extractText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return extractText(node.props.children);
  }
  return '';
}

export function CodeBlock(props: {
  readonly code: string;
  readonly language?: string | undefined;
  readonly className?: string;
}) {
  const { code, language, className } = props;
  const [copied, setCopied] = useState(false);
  const tokens = useMemo(() => highlightCode(code, language), [code, language]);

  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      className={cn(
        'group/code my-3 overflow-hidden rounded-lg border border-border-subtle bg-surface-2',
        className,
      )}
    >
      <div className="flex h-8 items-center justify-between border-b border-border-subtle bg-surface-3/60 pr-1 pl-3">
        <span className="font-mono text-[11px] text-tertiary">{language ?? 'text'}</span>
        <button
          type="button"
          onClick={() => void copy()}
          className="inline-flex h-6 cursor-pointer items-center gap-1 rounded px-1.5 text-[11px] text-tertiary opacity-0 transition-opacity duration-150 group-hover/code:opacity-100 hover:bg-surface-3 hover:text-primary"
        >
          {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-[12px] leading-[1.6] text-primary">
        <code>
          {tokens.map((token, index) =>
            token.kind === 'plain' ? (
              <span key={index}>{token.text}</span>
            ) : (
              <span key={index} className={`syntax-token-${token.kind}`}>
                {token.text}
              </span>
            ),
          )}
        </code>
      </pre>
    </div>
  );
}

const COMPONENTS: Components = {
  a: Anchor,
  code: InlineCode,
  pre: Pre,
  p: (props: ComponentProps<'p'>) => (
    <p className="my-2 leading-6 first:mt-0 last:mb-0" {...stripNode(props)} />
  ),
  h1: (props: ComponentProps<'h1'>) => (
    <h1 className="mt-5 mb-2 text-xl leading-7 font-semibold first:mt-0" {...stripNode(props)} />
  ),
  h2: (props: ComponentProps<'h2'>) => (
    <h2 className="mt-5 mb-2 text-lg leading-6 font-semibold first:mt-0" {...stripNode(props)} />
  ),
  h3: (props: ComponentProps<'h3'>) => (
    <h3 className="mt-4 mb-1.5 text-[15px] leading-6 font-semibold first:mt-0" {...stripNode(props)} />
  ),
  h4: (props: ComponentProps<'h4'>) => (
    <h4 className="mt-3 mb-1 text-sm leading-5 font-semibold first:mt-0" {...stripNode(props)} />
  ),
  ul: (props: ComponentProps<'ul'>) => (
    <ul className="my-2 list-disc space-y-1 pl-5 marker:text-tertiary" {...stripNode(props)} />
  ),
  ol: (props: ComponentProps<'ol'>) => (
    <ol className="my-2 list-decimal space-y-1 pl-5 marker:text-tertiary" {...stripNode(props)} />
  ),
  li: (props: ComponentProps<'li'>) => (
    <li className="leading-6" {...stripNode(props)} />
  ),
  blockquote: (props: ComponentProps<'blockquote'>) => (
    <blockquote
      className="my-3 border-l-2 border-border-strong pl-3 text-secondary italic"
      {...stripNode(props)}
    />
  ),
  hr: () => <hr className="my-4 border-divider" />,
  table: (props: ComponentProps<'table'>) => (
    <div className="my-3 overflow-x-auto rounded-lg border border-border-subtle">
      <table className="w-full border-collapse text-[12px]" {...stripNode(props)} />
    </div>
  ),
  th: (props: ComponentProps<'th'>) => (
    <th
      className="border-b border-border-subtle bg-surface-2 px-3 py-1.5 text-left font-medium text-secondary"
      {...stripNode(props)}
    />
  ),
  td: (props: ComponentProps<'td'>) => (
    <td className="border-b border-border-subtle px-3 py-1.5 last:border-b-0" {...stripNode(props)} />
  ),
  strong: (props: ComponentProps<'strong'>) => (
    <strong className="font-semibold text-primary" {...stripNode(props)} />
  ),
};

/** react-markdown 注入的 hast node 不是合法 DOM prop,渲染前剔除。 */
function stripNode<T>(props: T & { readonly node?: unknown }): T {
  const { node: _node, ...rest } = props;
  return rest as T;
}
