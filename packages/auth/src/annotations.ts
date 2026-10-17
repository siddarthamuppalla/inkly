import type { Role } from "./session.ts";

export type AnnotationChange = "edit" | "delete";

/**
 * Whether `actor` may change an Annotation drawn by `authorId`: authors edit and delete
 * their own; owners and admins may also delete anyone's. Viewers change nothing.
 */
export function mayChangeAnnotation(
  actor: { readonly userId: string; readonly role: Role },
  authorId: string,
  change: AnnotationChange,
): boolean {
  if (actor.role === "viewer") return false;
  if (actor.userId === authorId) return true;
  return change === "delete" && (actor.role === "owner" || actor.role === "admin");
}
