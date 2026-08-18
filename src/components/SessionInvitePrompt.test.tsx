// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, act } from '@testing-library/react';
import { SessionInvitePrompt } from './SessionInvitePrompt';

describe('SessionInvitePrompt', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('share mode states what was started and shows the code prominently', () => {
    render(<SessionInvitePrompt starterName="Yash" activity="a shared timer" code="P4HSZ7" />);
    expect(screen.getByText('You started a shared timer.')).toBeTruthy();
    expect(screen.getByText("Your person isn't here yet — share the code so they can join.")).toBeTruthy();
    expect(screen.getByLabelText('Join code P4HSZ7')).toBeTruthy();
    expect(screen.getByRole('button', { name: /copy code/i })).toBeTruthy();
    // Share mode offers no join button — the starter is not the joiner.
    expect(screen.queryByRole('button', { name: /join session/i })).toBeNull();
  });

  it('copy button copies exactly the code, never the invite URL', async () => {
    const writeText = navigator.clipboard.writeText as ReturnType<typeof vi.fn>;
    render(
      <SessionInvitePrompt
        starterName="Yash"
        activity="Cinema"
        code="P4HSZ7"
        inviteUrl="https://orbit.example/?code=P4HSZ7"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /copy code/i }));
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith('P4HSZ7');
    expect(writeText).not.toHaveBeenCalledWith('https://orbit.example/?code=P4HSZ7');
  });

  it('copy invite link copies the deep link', async () => {
    const writeText = navigator.clipboard.writeText as ReturnType<typeof vi.fn>;
    render(
      <SessionInvitePrompt
        starterName="Yash"
        activity="Canvas"
        code="P4HSZ7"
        inviteUrl="https://orbit.example/?code=P4HSZ7"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /copy invite link/i }));
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith('https://orbit.example/?code=P4HSZ7');
  });

  it('join mode names the starter and runs the join action', () => {
    const onJoin = vi.fn();
    render(
      <SessionInvitePrompt
        mode="join"
        starterName="Your person"
        activity="a shared activity"
        code="P4HSZ7"
        onJoin={onJoin}
      />,
    );
    expect(screen.getByText('Your person started a shared activity.')).toBeTruthy();
    expect(screen.getByText('Join them on Orbit.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /join session/i }));
    expect(onJoin).toHaveBeenCalledTimes(1);
  });

  it('never renders the session UUID, peer id, or token', () => {
    render(
      <SessionInvitePrompt
        starterName="Yash"
        activity="a shared timer"
        code="P4HSZ7"
        inviteUrl="https://orbit.example/?session=4c855d93-d579-48b3-b499-486ef17884bd&peer=becac066&token=secret-token"
      />,
    );
    const text = document.body.textContent ?? '';
    expect(text).toContain('P4HSZ7');
    expect(text).not.toContain('4c855d93-d579-48b3-b499-486ef17884bd');
    expect(text).not.toContain('secret-token');
    expect(text).not.toContain('becac066');
  });
});
