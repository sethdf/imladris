export async function main(
  approval_id: string,
  operation: string,
  resource: string,
  severity: string
) {
  return {
    message: "Waiting for human approval",
    approval_id,
    operation,
    resource,
    severity
  };
}
