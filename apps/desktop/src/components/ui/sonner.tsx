import type { CSSProperties } from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import {
  CircleCheckIcon,
  InfoIcon,
  TriangleAlertIcon,
  OctagonXIcon,
  Loader2Icon,
} from "lucide-react";

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="light"
      className="toaster group"
      position="bottom-right"
      richColors
      closeButton
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
          "--success-bg": "oklch(0.96 0.03 145)",
          "--success-border": "oklch(0.88 0.06 145)",
          "--success-text": "oklch(0.38 0.1 145)",
          "--error-bg": "oklch(0.97 0.02 27)",
          "--error-border": "oklch(0.9 0.05 27)",
          "--error-text": "var(--destructive)",
          "--warning-bg": "oklch(0.97 0.03 85)",
          "--warning-border": "oklch(0.9 0.06 85)",
          "--warning-text": "oklch(0.45 0.1 55)",
          "--info-bg": "oklch(0.97 0.01 250)",
          "--info-border": "oklch(0.9 0.03 250)",
          "--info-text": "oklch(0.4 0.08 250)",
        } as CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast font-sans shadow-lg",
          title: "font-medium",
          description: "whitespace-pre-wrap text-sm opacity-90",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
