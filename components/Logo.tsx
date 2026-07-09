interface Props {
  /** Compact = mark + wordmark inline (headers); full = with tagline (login). */
  variant?: "compact" | "full";
}

/**
 * dobrostanSTUDIOvisualisation — wordmark follows dobrostanstudio.com:
 * heavy Inter-style lettering, tight tracking, plum #50344f, gold asterisk.
 */
export default function Logo({ variant = "compact" }: Props) {
  return (
    <span className="inline-flex flex-col leading-none">
      <span className="flex items-center gap-1.5">
        <svg
          width={variant === "full" ? 30 : 22}
          height={variant === "full" ? 30 : 22}
          viewBox="0 0 32 32"
          aria-hidden="true"
          className="shrink-0"
        >
          <rect width="32" height="32" rx="8" fill="#50344f" />
          <g stroke="#b9a646" strokeWidth="3.4" strokeLinecap="round">
            <line x1="16" y1="7.5" x2="16" y2="24.5" />
            <line x1="8.6" y1="11.75" x2="23.4" y2="20.25" />
            <line x1="23.4" y1="11.75" x2="8.6" y2="20.25" />
          </g>
        </svg>
        <span
          className={`font-black tracking-[-0.05em] text-[#50344f] ${
            variant === "full" ? "text-2xl" : "text-lg"
          }`}
        >
          dobrostan<span className="text-[#1A1A1A]">STUDIO</span>
          <span className="text-[#b9a646]">*</span>
        </span>
      </span>
      <span
        className={`self-end font-medium uppercase tracking-[0.32em] text-[#8a887f] ${
          variant === "full" ? "text-[11px]" : "text-[9px]"
        }`}
      >
        visualisation
      </span>
    </span>
  );
}
