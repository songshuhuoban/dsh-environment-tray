import "react";
//#region src/client.ts
const inject = ["slots"];
function apply(ctx) {
	ctx.slots.inject("settings.plugins.tab", () => {});
}
//#endregion
export { apply, inject };
