import { LoaderCircle } from 'lucide-react';

import { cn } from '@/lib/cn';

export function Spinner(props: { readonly size?: number; readonly className?: string }) {
  const { size = 14, className } = props;
  return (
    <LoaderCircle
      size={size}
      className={cn('animate-spin-slow text-tertiary', className)}
      aria-label="loading"
    />
  );
}
