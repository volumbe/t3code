import { act, createElement, useLayoutEffect } from "react";
import { create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ComposerHandleContext, type ComposerHandleRef } from "../../composerHandleContext";
import {
  composerOwnsShortcutEvent,
  isInsideCollapsedComposerControls,
  isInsideComposerFloatingLayer,
  isInsideRestingComposerControlScope,
  useComposerMenuProps,
} from "./composerEventScope";

class FakeElement {
  constructor(private readonly matchingSelector: string | null) {}

  closest(selector: string): FakeElement | null {
    return this.matchingSelector !== null &&
      selector.split(",").some((candidate) => candidate === this.matchingSelector)
      ? this
      : null;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("composer menu focus", () => {
  it.each([
    ["an open menu", '[data-chat-composer-floating-layer="true"]', true],
    ["an unmounted menu", null, true],
    ["another control", "input", false],
  ])("closes while focus is on %s", async (_label, selector, shouldFocusComposer) => {
    const body = new FakeElement(null);
    const editor = new FakeElement(null);
    const activeElement = selector === null ? body : new FakeElement(selector);
    const document = { body, activeElement };
    const composerRef = {
      current: { focusAtEnd: () => (document.activeElement = editor) },
    } as unknown as ComposerHandleRef;
    vi.stubGlobal("Element", FakeElement);
    vi.stubGlobal("document", document);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let menuProps: ReturnType<typeof useComposerMenuProps> | undefined;
    function Probe() {
      const props = useComposerMenuProps();
      useLayoutEffect(() => {
        menuProps = props;
      }, [props]);
      return null;
    }
    const renderer = await act(() =>
      create(createElement(ComposerHandleContext, { value: composerRef }, createElement(Probe))),
    );
    try {
      expect(menuProps?.finalFocus?.()).toBe(false);
      expect(document.activeElement).toBe(shouldFocusComposer ? editor : activeElement);
    } finally {
      await act(() => renderer.unmount());
    }
  });
});

describe("composer event scopes", () => {
  it("recognizes events from the portaled resting controls", () => {
    vi.stubGlobal("Element", FakeElement);

    const target = new FakeElement('[data-chat-composer-resting-controls="true"]');
    expect(isInsideRestingComposerControlScope(target as unknown as EventTarget)).toBe(true);
  });

  it("recognizes events from the composer context strip controls", () => {
    vi.stubGlobal("Element", FakeElement);

    const target = new FakeElement("[data-composer-context-control]");
    expect(isInsideRestingComposerControlScope(target as unknown as EventTarget)).toBe(true);
  });

  it("keeps resting image previews focused without expanding their subtree", () => {
    vi.stubGlobal("Element", FakeElement);

    const target = new FakeElement('[data-chat-composer-resting-images="true"]');
    expect(isInsideRestingComposerControlScope(target as unknown as EventTarget)).toBe(true);
  });

  it("includes composer-owned floating layers in the resting control scope", () => {
    vi.stubGlobal("Element", FakeElement);

    const target = new FakeElement('[data-chat-composer-floating-layer="true"]');
    expect(isInsideComposerFloatingLayer(target as unknown as EventTarget)).toBe(true);
    expect(isInsideRestingComposerControlScope(target as unknown as EventTarget)).toBe(true);
  });

  it("leaves unrelated floating layers outside the composer scope", () => {
    vi.stubGlobal("Element", FakeElement);

    const target = new FakeElement('[data-slot="popover-popup"]');
    expect(isInsideComposerFloatingLayer(target as unknown as EventTarget)).toBe(false);
    expect(isInsideRestingComposerControlScope(target as unknown as EventTarget)).toBe(false);
  });

  it("leaves ordinary composer targets outside the portaled control scope", () => {
    vi.stubGlobal("Element", FakeElement);

    const target = new FakeElement(null);
    expect(isInsideRestingComposerControlScope(target as unknown as EventTarget)).toBe(false);
    expect(isInsideRestingComposerControlScope(null)).toBe(false);
  });

  it("recognizes banner and drawer controls docked above the surface", () => {
    vi.stubGlobal("Element", FakeElement);

    const target = new FakeElement('[data-chat-composer-collapsed-controls="true"]');
    expect(isInsideCollapsedComposerControls(target as unknown as EventTarget)).toBe(true);
    expect(isInsideCollapsedComposerControls(new FakeElement(null) as unknown as EventTarget)).toBe(
      false,
    );
    expect(isInsideCollapsedComposerControls(null)).toBe(false);
  });
});

class FakeTreeNode {
  constructor(
    readonly parent: FakeTreeNode | null,
    private readonly selector: string | null = null,
  ) {}

  closest(selector: string): FakeTreeNode | null {
    for (let node: FakeTreeNode | null = this; node; node = node.parent) {
      if (node.selector === selector) return node;
    }
    return null;
  }

  contains(other: FakeTreeNode): boolean {
    for (let node: FakeTreeNode | null = other; node; node = node.parent) {
      if (node === this) return true;
    }
    return false;
  }
}

describe("composer shortcut ownership", () => {
  it("gives a focus-scoped composer only the events from inside it", () => {
    vi.stubGlobal("Element", FakeTreeNode);
    vi.stubGlobal("Node", FakeTreeNode);
    const body = new FakeTreeNode(null);
    const mainForm = new FakeTreeNode(body);
    const mainEditor = new FakeTreeNode(mainForm);
    const dockScope = new FakeTreeNode(body, '[data-chat-composer-focus-scope="true"]');
    const dockForm = new FakeTreeNode(dockScope);
    const dockEditor = new FakeTreeNode(dockForm);
    const owns = (form: FakeTreeNode, target: FakeTreeNode) =>
      composerOwnsShortcutEvent(form as unknown as Element, target as unknown as EventTarget);

    expect(owns(mainForm, mainEditor)).toBe(true);
    expect(owns(mainForm, body)).toBe(true);
    expect(owns(mainForm, dockEditor)).toBe(false);
    expect(owns(dockForm, dockEditor)).toBe(true);
    expect(owns(dockForm, mainEditor)).toBe(false);
    expect(owns(dockForm, body)).toBe(false);
  });
});
