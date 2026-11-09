// Mock bcrypt implementation for testing
module.exports = {
  hashSync: (data, saltRounds) => {
    // Simple mock hash - just prepend "hashed_" with timestamp for uniqueness
    return `hashed_${data}_${Date.now()}_${Math.random()}`;
  },
  
  compareSync: (data, hash) => {
    // Simple mock compare - check if the hash contains the original data
    return hash.includes(data);
  },
  
  genSaltSync: (rounds) => {
    // Generate a simple mock salt
    return `salt_${rounds}_${Date.now()}`;
  },
  
  hash: async (data, saltRounds) => {
    return `hashed_${data}_${Date.now()}_${Math.random()}`;
  },
  
  compare: async (data, hash) => {
    return hash.includes(data);
  },
  
  genSalt: async (rounds) => {
    return `salt_${rounds}_${Date.now()}`;
  }
};