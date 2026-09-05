import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * Badges.
 *
 * The shadcn primitive shipped pointing at bg-primary / text-secondary-foreground
 * / border-border, none of which this project defines — so every badge rendered
 * as invisible text in a transparent box, which is a large part of why the app
 * looked flat. The variants below map to this project's semantic tokens
 * instead (see app/globals.css, "badge tones").
 *
 * Every tone is a triple: a tinted fill, a slightly darker border of a related
 * hue, and darker text again from the same family. The border is what makes a
 * badge read as an object rather than a highlighted word — a fill on its own is
 * the flat chip this replaced.
 *
 * Two rules hold for all of them:
 *
 *   Colour never carries meaning alone. Every badge contains a word. This is
 *   read in direct sun by someone in polarised sunglasses, and roughly one man
 *   in twelve cannot separate the moss from the brass anyway.
 *
 *   Every fill/text pair here clears 4.5:1. If a new tone does not, it is not
 *   a new tone.
 *
 * The original shadcn variants are kept so nothing that imports them breaks,
 * but they are re-pointed at real tokens too rather than left dead.
 */
const badgeVariants = cva(
  "group/badge inline-flex w-fit shrink-0 items-center justify-center gap-1.5 overflow-hidden border whitespace-nowrap transition-all focus-visible:ring-[3px] focus-visible:ring-line-strong [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        /* --- this project ------------------------------------------------ */
        /* Solid, because "urgent" has to win a glance across a maintenance
           shed. The only filled tone; everything else is a wrapped tint. */
        urgent:
          "bg-tone-urgent-fill border-tone-urgent-border text-tone-urgent-ink",
        high:
          "bg-tone-high-fill border-tone-high-border text-tone-high-ink",
        normal:
          "bg-tone-normal-fill border-tone-normal-border text-tone-normal-ink",
        low:
          "bg-tone-low-fill border-tone-low-border text-tone-low-ink",
        /* Cream fill, accent border, deep accent text — the club's own
           description of what it wanted. */
        department:
          "bg-tone-dept-fill border-tone-dept-border text-tone-dept-ink",
        status:
          "bg-tone-status-fill border-tone-status-border text-tone-status-ink",
        neutral:
          "bg-tone-neutral-fill border-tone-neutral-border text-tone-neutral-ink",

        /* --- shadcn compatibility ---------------------------------------- */
        default:
          "bg-accent-strong border-accent-strong text-ink-on-accent [a]:hover:opacity-90",
        secondary:
          "bg-surface-sunken border-line text-ink-secondary [a]:hover:border-line-strong",
        destructive:
          "bg-tone-urgent-fill border-tone-urgent-border text-tone-urgent-ink",
        outline:
          "border-line-strong text-ink-secondary [a]:hover:bg-surface-sunken",
        ghost:
          "border-transparent text-ink-secondary [a]:hover:bg-surface-sunken",
        link:
          "border-transparent text-accent-strong underline-offset-4 hover:underline",
      },
      size: {
        /* Sized up from the stock h-5/text-xs: this is a phone at arm's length
           outdoors, and 10px uppercase in a 20px pill is not readable there. */
        sm: "h-5 rounded-pill px-2 py-0 text-[11px] font-medium tracking-[0.01em]",
        default: "h-6 rounded-pill px-2.5 py-0 text-[12px] font-medium",
        lg: "h-7 rounded-pill px-3 py-0 text-[13px] font-semibold",
        /* For the one badge on a card that has to be seen first. */
        loud: "h-7 rounded-pill px-3 py-0 text-[12px] font-bold uppercase tracking-[0.08em]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  size = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant, size }), className),
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      variant,
      size,
    },
  })
}

export { Badge, badgeVariants }
