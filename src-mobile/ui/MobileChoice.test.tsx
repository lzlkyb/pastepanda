import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { MobileChoice } from "./MobileChoice";

afterEach(cleanup);
it("选择语义可读，箭头选择跳过不可用项并更新勾选", () => {
  function Choices() {
    const [value, setValue] = useState("甲");
    return <div role="radiogroup" aria-label="测试选择">
      {["甲", "乙", "丙"].map(name => <MobileChoice key={name} value={name} title={name}
        checked={value === name} onSelect={() => setValue(name)} disabled={name === "乙"} />)}
    </div>;
  }
  render(<Choices />);
  const first = screen.getByRole("radio", { name: "甲" });
  first.focus(); fireEvent.keyDown(first, { key: "ArrowDown" });
  const third = screen.getByRole("radio", { name: "丙" });
  expect(third.getAttribute("aria-checked")).toBe("true");
  expect(document.activeElement).toBe(third);
  fireEvent.keyDown(third, { key: "Home" });
  expect(first.getAttribute("aria-checked")).toBe("true");
});
