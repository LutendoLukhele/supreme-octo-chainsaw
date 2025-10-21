"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MessageType = void 0;
var MessageType;
(function (MessageType) {
    MessageType["STANDARD"] = "STANDARD";
    MessageType["TOOL_EXECUTION"] = "TOOL_EXECUTION";
    MessageType["PLAN_SUMMARY"] = "PLAN_SUMMARY";
    MessageType["STEP_ANNOUNCEMENT"] = "STEP_ANNOUNCEMENT";
    MessageType["STEP_COMPLETE"] = "STEP_COMPLETE";
})(MessageType || (exports.MessageType = MessageType = {}));
