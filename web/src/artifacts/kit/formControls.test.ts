import { afterEach, expect, it, vi } from "vitest";
import javascript from "./triune-artifact.js?raw";
import manifest from "./manifest.json";

interface Kit {
  init: (root: HTMLElement) => void;
  refresh: (root: HTMLElement) => void;
}
const kit = () => (window as unknown as { TriuneArtifact: Kit }).TriuneArtifact;
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function mount() {
  document.body.innerHTML = `<main class="ta-root"><form>
<label class="ta-choice"><input name="choice" type="checkbox" data-ta-mixed>Choose</label>
<label class="ta-field">Amount<input type="range" name="amount" min="10" max="50" step="5" value="20"></label>
<progress aria-label="Usage" value="20" max="50"></progress><button type="reset">Reset</button>
</form></main>`;
  new Function(javascript)();
  const root = document.querySelector<HTMLElement>("main")!;
  kit().init(root);
  return {
    root,
    form: root.querySelector("form")!,
    checkbox: root.querySelector<HTMLInputElement>('[type="checkbox"]')!,
    range: root.querySelector<HTMLInputElement>('[type="range"]')!,
  };
}

it("initializes native mixed state and range fill without changing form or input/change semantics", () => {
  const { root, form, checkbox, range } = mount();
  expect(checkbox.indeterminate).toBe(true);
  expect(range.style.getPropertyValue("--ta-range-progress")).toBe("25%");
  const input = vi.fn(),
    change = vi.fn(),
    submit = vi.fn((event: Event) => event.preventDefault());
  form.addEventListener("input", input);
  form.addEventListener("change", change);
  form.addEventListener("submit", submit);
  checkbox.click();
  expect(checkbox.checked).toBe(true);
  expect(checkbox.indeterminate).toBe(false);
  expect(input).toHaveBeenCalledOnce();
  expect(change).toHaveBeenCalledOnce();
  expect(new FormData(form).get("choice")).toBe("on");
  expect(new FormData(form).get("amount")).toBe("20");
  expect(submit).not.toHaveBeenCalled();
  kit().init(root);
  expect(checkbox.indeterminate).toBe(false);
  expect(root.querySelectorAll('[role="tooltip"]')).toHaveLength(1);
});

it("refreshes input, change, silent restore and reset without fabricating author events", async () => {
  const { form, range } = mount();
  const input = vi.fn(),
    change = vi.fn();
  form.addEventListener("input", input);
  form.addEventListener("change", change);
  range.value = "40";
  range.dispatchEvent(new Event("input", { bubbles: true }));
  expect(range.style.getPropertyValue("--ta-range-progress")).toBe("75%");
  range.value = "50";
  range.dispatchEvent(new Event("change", { bubbles: true }));
  expect(range.style.getPropertyValue("--ta-range-progress")).toBe("100%");
  range.value = "10";
  window.dispatchEvent(new Event("triune-artifact:restored"));
  expect(range.style.getPropertyValue("--ta-range-progress")).toBe("0%");
  expect(input).toHaveBeenCalledOnce();
  expect(change).toHaveBeenCalledOnce();
  form.reset();
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  expect(range.value).toBe("20");
  expect(range.style.getPropertyValue("--ta-range-progress")).toBe("25%");
});

it("declares native controls, zero dependencies, current asset budgets and opt-in guidance", () => {
  expect(manifest.native_behavior.supported).toEqual(
    expect.arrayContaining(["native checkbox and mixed state", "native range", "native progress"]),
  );
  expect(manifest.native_behavior.form_controls.checkbox).toContain("ta-choice");
  expect(manifest.runtime.dependencies).toEqual([]);
  expect(manifest.assets["triune-artifact.css"].bytes).toBeLessThanOrEqual(
    manifest.budgets_bytes.css,
  );
  expect(manifest.assets["triune-artifact.js"].bytes).toBeLessThanOrEqual(
    manifest.budgets_bytes.javascript,
  );
});
