import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@subscriptiq/ui';
const variants = cva('sq-button', {
  variants: {
    variant: { default: 'sq-primary', outline: 'sq-outline', destructive: 'sq-destructive' },
  },
  defaultVariants: { variant: 'default' },
});
export function Button({
  className,
  variant,
  asChild = false,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof variants> & { asChild?: boolean }) {
  const Component = asChild ? Slot : 'button';
  return <Component className={cn(variants({ variant }), className)} {...props} />;
}
