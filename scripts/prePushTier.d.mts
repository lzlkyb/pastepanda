export function decideTier(stdinText: string): "full" | "light";

export interface OwnershipRepo {
  exists(sha: string): boolean;
  isAncestor(older: string, newer: string): boolean;
  tipAuthor(sha: string): string | null;
  droppedAuthors(newSha: string, oldSha: string): string[];
}

export interface OwnershipViolation {
  remoteRef: string;
  dropped: string[];
  oldSha: string;
}

export function decideOwnership(input: {
  refLines: string;
  myEmails: string[];
  repo: OwnershipRepo;
}): { violations: OwnershipViolation[] };
