import { resetTestDatabase } from "../testing.js";

await resetTestDatabase();

console.log("Isolated test database rebuilt from reviewed migrations.");
