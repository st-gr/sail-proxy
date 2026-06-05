describe('Test Infrastructure', () => {
  test('should be able to run basic test', () => {
    expect(1 + 1).toBe(2);
  });

  test('should have TypeScript support', () => {
    const testObj: { value: number } = { value: 42 };
    expect(testObj.value).toBe(42);
  });
});