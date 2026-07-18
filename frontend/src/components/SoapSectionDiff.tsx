import { diffWords } from 'diff'

type SoapSectionDiffProps = {
  label: string
  before: string
  after: string
  onConfirm: () => void
  onReject: () => void
}

/**
 * Renders a word-level diff of a proposed SOAP section edit — additions
 * highlighted in green, removals struck through in red — with Confirm/Reject
 * actions. Used in place of the plain textarea while a section has a
 * pending voice/AI proposal.
 */
export function SoapSectionDiff({
  label,
  before,
  after,
  onConfirm,
  onReject,
}: SoapSectionDiffProps) {
  const parts = diffWords(before ?? '', after ?? '')

  return (
    <div className="soap-section diff-pending">
      <div className="soap-diff-heading">
        <span>{label}</span>
        <span className="pending-badge">Pending changes</span>
      </div>
      <div className="soap-diff-text">
        {parts.length === 0 || parts.every((part) => !part.value) ? (
          <span className="empty">(no changes)</span>
        ) : (
          parts.map((part, index) => (
            <span
              key={index}
              className={
                part.added ? 'diff-added' : part.removed ? 'diff-removed' : undefined
              }
            >
              {part.value}
            </span>
          ))
        )}
      </div>
      <div className="soap-diff-actions">
        <button type="button" className="small" onClick={onConfirm}>
          Confirm
        </button>
        <button type="button" className="secondary small" onClick={onReject}>
          Reject
        </button>
      </div>
    </div>
  )
}
