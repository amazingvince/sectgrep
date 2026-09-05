export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    overview: (
      <>
        <path d="m3 10 9-7 9 7v11H3z" />
        <path d="M9 21v-8h6v8" />
      </>
    ),
    extraction: (
      <>
        <rect x="5" y="3" width="14" height="18" rx="2" />
        <path d="M9 7h6M9 11h6M9 15h4" />
      </>
    ),
    knowledge: (
      <>
        <rect x="5" y="3" width="14" height="15" rx="2" />
        <path d="M3 7v14h13M8 7h8M8 11h8M8 15h4" />
      </>
    ),
    benchmark: (
      <>
        <path d="M3 21h18M5 21V11h3v10M11 21V4h3v17M17 21V8h3v13" />
      </>
    ),
    accept: <path d="m5 12 4 4L20 5" />,
    reject: <path d="m5 5 14 14M19 5 5 19" />,
    defer: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 6v6l4 2" />
      </>
    ),
    next: <path d="m9 5 7 7-7 7" />,
    download: (
      <>
        <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />
      </>
    ),
    menu: <path d="M3 6h18M3 12h18M3 18h18" />,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? paths.extraction}
    </svg>
  );
}
