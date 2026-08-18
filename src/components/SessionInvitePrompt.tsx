import React, { useState } from 'react';
import { Check, Copy, ExternalLink, X } from 'lucide-react';

/**
 * One reusable invitation surface for the whole app.
 *
 * "Share" mode is the starter's side: it states what they started and makes
 * the join code visible with copy actions, so the invitee is never told to
 * "join via code" without being able to see (or copy) the code.
 *
 * "Join" mode is the invitee's side: it names the starter and offers a single
 * Join action that runs the existing secure join-by-code flow.
 *
 * Only the human-friendly code ever leaves this component — never the session
 * UUID, peer id, or peer token.
 */
export interface SessionInvitePromptProps {
  /** Display name of the person who started the activity. */
  starterName: string;
  /** Human-friendly activity label ("a shared timer", "Cinema", "Canvas", …). */
  activity?: string;
  /** The authoritative human-friendly join code from the current session. */
  code: string;
  /** Optional deep link that opens Orbit pre-filled with the code. */
  inviteUrl?: string;
  /** Which side is looking at it. Defaults to 'share'. */
  mode?: 'share' | 'join';
  /** Runs the join flow (join mode). Defaults to opening the invite URL. */
  onJoin?: () => void;
  /** Optional quiet dismiss control (share mode). */
  onDismiss?: () => void;
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the execCommand path
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

export const SessionInvitePrompt: React.FC<SessionInvitePromptProps> = ({
  starterName,
  activity,
  code,
  inviteUrl,
  mode = 'share',
  onJoin,
  onDismiss
}) => {
  const [copied, setCopied] = useState(false);
  const timerRef = React.useRef<number | null>(null);

  const handleCopyCode = async () => {
    if (await copyText(code)) {
      setCopied(true);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleCopyInvite = async () => {
    if (!inviteUrl) return;
    if (await copyText(inviteUrl)) {
      setCopied(true);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleJoin = () => {
    if (onJoin) {
      onJoin();
      return;
    }
    if (inviteUrl) window.location.href = inviteUrl;
  };

  const title =
    mode === 'join'
      ? `${starterName} started ${activity ?? 'a shared activity'}.`
      : `You started ${activity ?? 'a shared activity'}.`;
  const sub =
    mode === 'join'
      ? 'Join them on Orbit.'
      : "Your person isn't here yet — share the code so they can join.";

  return (
    <section className="glass-panel invite-prompt" aria-label="Session invitation">
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="invite-prompt-dismiss"
          aria-label="Dismiss invitation"
        >
          <X size={16} />
        </button>
      )}
      <div className="invite-prompt-copy">
        <p className="invite-prompt-title">{title}</p>
        <p className="invite-prompt-sub">{sub}</p>
      </div>

      <div className="invite-prompt-actions">
        <div className="invite-code-block" aria-label={`Join code ${code}`}>
          <span className="eyebrow">Join code</span>
          <span className="invite-code">{code}</span>
        </div>
        <div className="invite-prompt-buttons">
          <button
            type="button"
            onClick={handleCopyCode}
            className="btn btn-outline"
            aria-label="Copy code"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? 'Copied' : 'Copy code'}
          </button>
          {mode === 'share' && inviteUrl ? (
            <button
              type="button"
              onClick={handleCopyInvite}
              className="btn btn-outline"
              aria-label="Copy invite link"
            >
              {copied ? <Check size={14} /> : <ExternalLink size={14} />}
              {copied ? 'Copied' : 'Copy invite link'}
            </button>
          ) : null}
          {mode === 'join' ? (
            <button type="button" onClick={handleJoin} className="btn btn-primary">
              Join session
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
};

export default SessionInvitePrompt;
