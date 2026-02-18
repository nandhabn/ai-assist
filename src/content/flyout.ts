export function createFlyout() {
  const flyout = document.createElement("div");
  flyout.id = "flow-recorder-flyout";

  // Add a stable attribute to identify this as part of the extension's UI
  flyout.dataset.flowRecorder = "true";

  flyout.innerHTML = `
    <div id="flyout-header">
      <h2>Suggested Actions</h2>
      <button id="flyout-toggle">-</button>
    </div>
    <div id="flyout-content">
      <p>Analyzing page for actions...</p>
    </div>
  `;
  document.body.appendChild(flyout);

  const toggleButton = document.getElementById("flyout-toggle");
  const content = document.getElementById("flyout-content");
  toggleButton?.addEventListener("click", () => {
    if (content) {
      const isVisible = content.style.display !== "none";
      content.style.display = isVisible ? "none" : "block";
      toggleButton.textContent = isVisible ? "+" : "-";
    }
  });

  return flyout;
}
