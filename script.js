const form = document.querySelector("#signup-form");
const phoneInput = document.querySelector("#phone");
const phoneError = document.querySelector("#phone-error");
const successState = document.querySelector("#success-state");
const resetButton = document.querySelector("#reset-form");

phoneInput.addEventListener("input", (event) => {
  const digits = event.target.value.replace(/\D/g, "").replace(/^995/, "").slice(0, 9);
  const groups = digits.match(/.{1,3}/g)?.join(" ") ?? "";
  event.target.value = digits ? `+995 ${groups}` : "";
  phoneError.textContent = "";
  phoneInput.removeAttribute("aria-invalid");
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const phone = phoneInput.value.replace(/\D/g, "").replace(/^995/, "");

  if (!/^5\d{8}$/.test(phone)) {
    phoneError.textContent = "შეიყვანე ვალიდური 9-ნიშნა ნომერი, მაგალითად 5XX XX XX XX.";
    phoneInput.setAttribute("aria-invalid", "true");
    phoneInput.focus();
    return;
  }
  form.hidden = true;
  successState.hidden = false;
});

resetButton.addEventListener("click", () => {
  form.reset();
  phoneError.textContent = "";
  phoneInput.removeAttribute("aria-invalid");
  form.hidden = false;
  successState.hidden = true;
  phoneInput.focus();
});
