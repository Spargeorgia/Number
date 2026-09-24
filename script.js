const form = document.querySelector("#signup-form");
const phoneInput = document.querySelector("#phone");
const phoneError = document.querySelector("#phone-error");
const successState = document.querySelector("#success-state");
const resetButton = document.querySelector("#reset-form");
const submitButton = form.querySelector(".submit-button");
const websiteInput = document.querySelector("#website");

phoneInput.addEventListener("input", (event) => {
  const digits = event.target.value.replace(/\D/g, "").replace(/^995/, "").slice(0, 9);
  const groups = digits.match(/.{1,3}/g)?.join(" ") ?? "";
  event.target.value = digits ? `+995 ${groups}` : "";
  phoneError.textContent = "";
  phoneInput.removeAttribute("aria-invalid");
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const phone = phoneInput.value.replace(/\D/g, "").replace(/^995/, "");

  if (!/^5\d{8}$/.test(phone)) {
    phoneError.textContent = "შეიყვანე ვალიდური 9-ნიშნა ნომერი, მაგალითად 5XX XX XX XX.";
    phoneInput.setAttribute("aria-invalid", "true");
    phoneInput.focus();
    return;
  }

  submitButton.disabled = true;
  submitButton.textContent = "იგზავნება…";
  form.setAttribute("aria-busy", "true");

  try {
    const response = await fetch("/api/consents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phone: `+995${phone}`,
        website: websiteInput.value,
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        throw new Error("rate_limited");
      }
      throw new Error("submit_failed");
    }

    form.hidden = true;
    successState.hidden = false;
  } catch (error) {
    phoneError.textContent =
      error.message === "rate_limited"
        ? "დაფიქსირდა ბევრი მცდელობა. გთხოვ, ერთ წუთში სცადო ხელახლა."
        : "ნომრის შენახვა ვერ მოხერხდა. გთხოვ, სცადო ხელახლა.";
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "თანხმობა";
    form.removeAttribute("aria-busy");
  }
});

resetButton.addEventListener("click", () => {
  form.reset();
  phoneError.textContent = "";
  phoneInput.removeAttribute("aria-invalid");
  form.hidden = false;
  successState.hidden = true;
  phoneInput.focus();
});
