import { AutoPrint } from '@/components/print/AutoPrint';
import type { AgreementParts, AgreementSignatory } from '@/lib/agreements/merge';

/** Print titles by agreement kind, shared by the admin and portal print routes. */
export const AGREEMENT_TITLE: Record<string, string> = {
  ic_agreement: 'Independent Contractor Agreement',
  non_compete: 'Non-Compete Agreement',
  confidentiality_nda: 'Confidentiality / NDA',
  baa: 'Business Associate Agreement',
};

const PRE_STYLE = {
  whiteSpace: 'pre-wrap',
  fontFamily: 'Georgia, serif',
  fontSize: 14,
  lineHeight: 1.55,
  margin: 0,
} as const;

/**
 * The one agreement print layout (admin + portal, live template or frozen
 * version). `parts` comes from renderAgreementParts: escaped labels/meta as
 * text children, and an <img> only for a safeSigImg-approved data-URI.
 */
export function AgreementPrint({
  title,
  workerName,
  parts,
}: {
  title: string;
  workerName: string;
  parts: AgreementParts;
}) {
  return (
    <div
      style={{
        maxWidth: 720,
        margin: '40px auto',
        padding: '0 24px',
        color: '#111',
        fontFamily: 'Georgia, serif',
        lineHeight: 1.55,
      }}
    >
      <AutoPrint />
      <h1 style={{ color: '#1F3A68', fontSize: 22, marginBottom: 4 }}>{title}</h1>
      <p style={{ color: '#677083', fontSize: 12, marginTop: 0 }}>{workerName}</p>

      <pre style={PRE_STYLE}>{parts.mergedText}</pre>

      <div style={{ marginTop: 32, display: 'flex', gap: 48, flexWrap: 'wrap' }}>
        <Signatory part={parts.contractor} />
        <Signatory part={parts.countersign} />
      </div>
    </div>
  );
}

function Signatory({ part }: { part: AgreementSignatory }) {
  return (
    <div>
      <div
        style={{
          borderBottom: '1px solid #000',
          minWidth: 240,
          minHeight: 30,
          paddingBottom: 2,
        }}
      >
        {part.imgSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          // biome-ignore lint/performance/noImgElement: print layout needs a real <img> for the signature data URL to render in PDF/print
          <img
            src={part.imgSrc}
            alt="signature"
            style={{
              height: 46,
              maxWidth: 240,
              objectFit: 'contain',
              display: 'block',
            }}
          />
        ) : part.name ? (
          <span style={{ fontFamily: 'cursive', fontSize: 18 }}>{part.name}</span>
        ) : null}
      </div>
      <div style={{ fontSize: 12, color: '#444', marginTop: 4 }}>
        <div>{part.label}</div>
        <div>{part.meta}</div>
      </div>
    </div>
  );
}
