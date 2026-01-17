module.exports = {
    testEnvironment: 'node',
    testMatch: ['**/test/**/*.test.js'],
    testPathIgnorePatterns: ['/node_modules/'],
    setupFilesAfterEnv: ['<rootDir>/test/setup.js'],
    testTimeout: 30000, // Git operations can be slow
};
