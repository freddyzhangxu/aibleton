/**
 * One optional, server-measured goal verdict for the current user turn.
 * This small state bridge lets the chat persistence layer create an honest
 * task receipt without depending on the agent runtime's larger private state.
 */
export type TurnGoalOutcome = {
  status: "passed" | "unmet";
  objective: string;
  verification?: string;
};

let outcome: TurnGoalOutcome | undefined;

export function setTurnGoalOutcome(value: TurnGoalOutcome): void {
  outcome = value;
}

export function turnGoalOutcome(): TurnGoalOutcome | undefined {
  return outcome;
}

export function clearTurnGoalOutcome(): void {
  outcome = undefined;
}
