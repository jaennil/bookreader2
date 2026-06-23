import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

const base = (props: IconProps) => ({
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  ...props
});

export function LibraryIcon(props: IconProps) {
  return <svg {...base(props)}><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/></svg>;
}

export function HeartIcon(props: IconProps) {
  return <svg {...base(props)}><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z"/></svg>;
}

export function UploadIcon(props: IconProps) {
  return <svg {...base(props)}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>;
}

export function SearchIcon(props: IconProps) {
  return <svg {...base(props)}><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>;
}

export function PlusIcon(props: IconProps) {
  return <svg {...base({ ...props, strokeWidth: 2 })}><path d="M12 5v14M5 12h14"/></svg>;
}

export function ChevronIcon(props: IconProps) {
  return <svg {...base({ ...props, strokeWidth: 2 })}><path d="m9 18 6-6-6-6"/></svg>;
}

export function BackIcon(props: IconProps) {
  return <svg {...base(props)}><path d="m15 18-6-6 6-6"/></svg>;
}

export function CloseIcon(props: IconProps) {
  return <svg {...base(props)}><path d="M18 6 6 18M6 6l12 12"/></svg>;
}

export function CheckIcon(props: IconProps) {
  return <svg {...base({ ...props, strokeWidth: 2 })}><path d="m20 6-11 11-5-5"/></svg>;
}

export function CloudIcon(props: IconProps) {
  return <svg {...base(props)}><path d="M17.5 19H9a7 7 0 1 1 6.7-9h1.8a4.5 4.5 0 1 1 0 9Z"/><path d="m9 13 3-3 3 3M12 10v6"/></svg>;
}

export function InfoIcon(props: IconProps) {
  return <svg {...base(props)}><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>;
}

export function TrashIcon(props: IconProps) {
  return <svg {...base(props)}><path d="M3 6h18M8 6V4h8v2M19 6l-1 15H6L5 6M10 11v5M14 11v5"/></svg>;
}
