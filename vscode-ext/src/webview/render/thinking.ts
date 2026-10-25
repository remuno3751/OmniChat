/** State of the reasoning block, kept free of DOM so it can be unit-tested. */
export interface ThinkingView {
  /** Show the live "Thinking..." line with the dots (streaming and no answer text yet). */
  live: boolean;
  /** When non-null the block must be set to this open state; null leaves the user's choice alone. */
  forceOpen: boolean | null;
}

export interface ThinkingModel {
  /** The user clicked the summary: from now on the open state is theirs. */
  userToggled(): void;
  update(input: { streaming: boolean; hasText: boolean }): ThinkingView;
}

export function createThinkingModel(): ThinkingModel {
  let touched = false;
  return {
    userToggled() {
      touched = true;
    },
    update({ streaming, hasText }) {
      // A finished turn with no answer text keeps its reasoning open, so the reply is never hidden behind a closed fold.
      return { live: streaming && !hasText, forceOpen: touched ? null : !streaming && !hasText };
    },
  };
}
