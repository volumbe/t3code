import { useComposerHandleContext } from "../../composerHandleContext";

const COMPOSER_FLOATING_LAYER_SELECTOR = [
  '[data-composer-drawer-layer="true"]',
  '[data-chat-composer-floating-layer="true"]',
].join(",");

export const composerFloatingLayerProps = {
  "data-chat-composer-floating-layer": "true",
} as const;

export function useComposerMenuProps() {
  const composerRef = useComposerHandleContext();

  return {
    ...composerFloatingLayerProps,
    finalFocus: composerRef
      ? () => {
          const activeElement = document.activeElement;
          if (activeElement !== document.body && !isInsideComposerFloatingLayer(activeElement)) {
            return false;
          }
          composerRef.current?.focusAtEnd();
          return false;
        }
      : undefined,
  };
}

export function isInsideComposerFloatingLayer(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(COMPOSER_FLOATING_LAYER_SELECTOR) !== null;
}

// Banners, the approval row, and the tasks badge dock above the surface. A
// pointer or focus landing on one of them acts on that control and must not
// expand a resting or collapsed composer.
export function isInsideCollapsedComposerControls(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('[data-chat-composer-collapsed-controls="true"]') !== null
  );
}

export function isInsideRestingComposerControlScope(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    (target.closest('[data-chat-composer-resting-controls="true"]') !== null ||
      target.closest('[data-chat-composer-resting-images="true"]') !== null ||
      target.closest("[data-composer-context-control]") !== null ||
      isInsideComposerFloatingLayer(target))
  );
}

// A second composer, such as the dock chat's, marks its root so window-level
// shortcuts act on it only while focus is inside it, and the main chat leaves
// those events to it.
export const focusScopedComposerProps = {
  "data-chat-composer-focus-scope": "true",
} as const;

const FOCUS_SCOPED_COMPOSER_SELECTOR = '[data-chat-composer-focus-scope="true"]';

export function isInsideFocusScopedComposer(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(FOCUS_SCOPED_COMPOSER_SELECTOR) !== null;
}

/**
 * Whether a composer rooted at `composerElement` owns a window-level shortcut.
 * A focus-scoped composer owns only events from inside its scope; any other
 * composer owns every event except those.
 */
export function composerOwnsShortcutEvent(
  composerElement: Element | null,
  target: EventTarget | null,
): boolean {
  const scope = composerElement?.closest(FOCUS_SCOPED_COMPOSER_SELECTOR) ?? null;
  if (scope === null) return !isInsideFocusScopedComposer(target);
  return target instanceof Node && scope.contains(target);
}

/** Composer commands the main chat leaves to a focused focus-scoped composer. */
export const FOCUS_SCOPED_COMPOSER_COMMANDS: ReadonlySet<string> = new Set([
  "modelPicker.toggle",
  "composer.host",
  "composer.effort",
  "composer.mode",
  "composer.workspace",
  // The dock composer has no branch toolbar; it swallows these so they never
  // reach the main thread's branch picker.
  "composer.branch",
  "composer.previousWorktree",
  "thread.stop",
]);
