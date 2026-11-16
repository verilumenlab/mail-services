import type { Metadata } from "next";
import { Caveat, Dancing_Script, Great_Vibes, Sacramento } from "next/font/google";
import { SignerApp } from "@/components/esign/signer-app";

const dancing = Dancing_Script({ subsets: ["latin"], weight: ["500"] });
const greatVibes = Great_Vibes({ subsets: ["latin"], weight: ["400"] });
const caveat = Caveat({ subsets: ["latin"], weight: ["500"] });
const sacramento = Sacramento({ subsets: ["latin"], weight: ["400"] });

export const metadata: Metadata = {
  title: "Review and sign",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/** Public signing page. Authorisation comes from the link token; no app session is used. */
export default async function SignPage({ params }: PageProps<"/sign/[token]">) {
  const { token } = await params;
  const fonts = [
    { id: "dancing", label: "Dancing Script", family: dancing.style.fontFamily },
    { id: "great-vibes", label: "Great Vibes", family: greatVibes.style.fontFamily },
    { id: "caveat", label: "Caveat", family: caveat.style.fontFamily },
    { id: "sacramento", label: "Sacramento", family: sacramento.style.fontFamily },
  ];
  return (
    <>
      <div aria-hidden className="pointer-events-none absolute h-0 overflow-hidden opacity-0">
        {[dancing, greatVibes, caveat, sacramento].map((f) => (
          <span key={f.style.fontFamily} className={f.className}>
            Signature
          </span>
        ))}
      </div>
      <SignerApp token={token} fonts={fonts} />
    </>
  );
}
