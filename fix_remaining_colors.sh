#!/bin/bash
FILE="src/styles.css"

# .primary-button:hover background: #82e8cf (lighter teal)
# Let's use #89d6ff (lighter blue for hover, based on #5bc4ff)
sed -i 's/#82e8cf/#89d6ff/g' "$FILE"

# .progress-track span background: linear-gradient(90deg, #42b99c, #8be8ce)
# Old darker teal to lighter teal.
# Let's change to dark blue (#289ce0) to lighter blue (#89d6ff)
sed -i 's/#42b99c/#289ce0/g' "$FILE"
sed -i 's/#8be8ce/#89d6ff/g' "$FILE"
