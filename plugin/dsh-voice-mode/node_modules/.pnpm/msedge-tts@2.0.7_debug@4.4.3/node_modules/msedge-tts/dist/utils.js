"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.joinPath = void 0;
const joinPath = (...parts) => {
    return parts
        .filter(Boolean)
        .join("/")
        .replace(/\/{2,}/g, "/");
};
exports.joinPath = joinPath;
