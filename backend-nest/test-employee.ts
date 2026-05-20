async function testCreateEmployee() {
  const testEmployee = {
    employeeId: "EMP998",
    name: "Test User",
    username: "test998",
    password: "EMP998",
    hourlyRate: 500,
    department: "قسم القص",
    roleId: "role-id-here",
    scheduledStart: "08:00",
    scheduledEnd: "16:00",
  };

  try {
    console.log("Sending request to:", "http://localhost:5001/api/employees");
    console.log("Payload:", JSON.stringify(testEmployee, null, 2));

    const response = await fetch("http://localhost:5001/api/employees", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(testEmployee),
    });

    const data = await response.json();
    console.log("Status:", response.status);
    console.log("Response:", JSON.stringify(data, null, 2));

    if (response.ok) {
      console.log("✅ Success!");
    } else {
      console.log("❌ Error:", data.message || data.error?.message || JSON.stringify(data));
    }
  } catch (error) {
    console.error("❌ Network Error:", error);
  }
}

testCreateEmployee();