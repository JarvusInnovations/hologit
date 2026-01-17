// Global test setup for hologit tests

// Increase timeout for git operations
jest.setTimeout(30000);

// Store original working directory to restore after tests
const originalCwd = process.cwd();
const originalEnv = { ...process.env };

afterEach(() => {
    // Restore working directory if changed during test
    if (process.cwd() !== originalCwd) {
        process.chdir(originalCwd);
    }
});

afterAll(() => {
    // Restore environment
    process.env = originalEnv;
});
