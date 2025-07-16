// functions/index.js
const { onRequest } = require("firebase-functions/v2/https"); // ✅ Correct
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

// --- Configuration for Scoring ---
// Puan etkilerini dinamik olarak dışarıdan almak için yapılandırma.
// Bu obje, "yumuşak" tercihlerin puanlarını merkezi bir yerden yönetmeyi sağlar.
const scoringConfig = {
    children: {
        mismatchPenalty: -40, // B'nin çocuğu var, A'nın yok
        sameStatusBonus: 10,  // İkisinin de var veya ikisinin de yok
    },
    wantsChildren: {
        similarBonus: 15,
    },
    politicalView: {
        similarBonus: 12,
    },
    education: {
        higherOrSameBonus: { min: 10, max: 15 },
        lowerPenalty: { min: -15, max: -10 },
    },
    religion: {
        similarBonus: 8,
    },
    height: { // Boy farkı azaldıkça verilecek puan
        maxBonus: 10,
        minBonus: 5,
    },
    ethnicity: {
        similarBonus: 5,
    },
    workplace: {
        sameBonus: 10,
    },
    profileCompletion: {
        promptsFilledBonus: 5,
        voicePromptBonus: 8,
    },
    substanceUse: {
        // A kullanmıyor, B kullanıyor durumu için ceza puanı
        mismatchPenalty: -15,
        // İkisi de birebir aynı alışkanlığa sahipse (ikisi de hiç / ikisi de sosyal vb.)
        exactMatchBonus: 10,
        // İkisi de kullanıyor ama sıklıkları farklıysa (biri sosyal, biri sık)
        closeMatchBonus: 5,
    },
    hometown: {
        sameBonus: 5,
    },
    interests: {
        perInterestBonus: 10, // Ortak her ilgi alanı için puan
        maxBonus: 50,         // İlgi alanlarından kazanılabilecek maksimum puan
    }
};


/**
 * Calculates the distance in kilometers between two geographical points.
 * @param {object} loc1 - Location object with {lat, lon}.
 * @param {object} loc2 - Location object with {lat, lon}.
 * @returns {number} Distance in km.
 */
function calculateDistance(loc1, loc2) {
    const R = 6371; // Earth's radius in km
    const toRad = (deg) => deg * Math.PI / 180;
    const dLat = toRad(loc2.lat - loc1.lat);
    const dLon = toRad(loc2.lon - loc1.lon);
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos(toRad(loc1.lat)) * Math.cos(toRad(loc2.lat))
        * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

/**
 * Checks for "Hard" compatibility issues that would disqualify a match.
 * These are non-negotiable deal-breakers.
 * @param {object} userA - The user for whom we are finding matches.
 * @param {object} userB - The potential match.
 * @returns {boolean} - True if compatible, false if not.
 */
function checkCompatibility(userA, userB) {
    const prefsA = userA.preferences;

    // 1. Gender check
    if (prefsA.gender !== userB.gender) {
        return false;
    }

    // 2. Age range check
    if (userB.age < prefsA.minAge || userB.age > prefsA.maxAge) {
        return false;
    }

    // 3. Distance check
    const distance = calculateDistance(userA.location, userB.location);
    if (distance > prefsA.maxDistance) {
        return false;
    }

    // 4. Substance Use (Hard Filters)
    // A uyuşturucu kullanmayan birini arıyor ve B kullanıyorsa
    if (prefsA.drugPolicy === 'never' && userB.usesDrugs) {
        return false;
    }
    // A, "kesinlikle alkol kullanmamalı" diyor ve B kullanıyorsa
    if (prefsA.alcoholPolicy === 'never' && userB.alcoholFrequency !== 'never') {
        return false;
    }
    // A, "kesinlikle sigara kullanmamalı" diyor ve B kullanıyorsa
    if (prefsA.smokingPolicy === 'never' && userB.smokingFrequency !== 'never') {
        return false;
    }

    return true;
}


/**
 * Calculates a compatibility score based on "soft" preferences.
 * @param {object} scorer - The user for whom we are calculating the score.
 * @param {object} target - The user being scored.
 * @returns {number} - The compatibility score.
 */
function calculateScore(scorer, target) {
    let score = 0;
    const config = scoringConfig;

    if (target.hasChildren && !scorer.hasChildren) {
        score += config.children.mismatchPenalty;
    } else if (target.hasChildren === scorer.hasChildren) {
        score += config.children.sameStatusBonus;
    }

    if (target.wantsChildren === scorer.wantsChildren) {
        score += config.wantsChildren.similarBonus;
    }

    if (target.politicalView && target.politicalView === scorer.politicalView) {
        score += config.politicalView.similarBonus;
    }

    if (target.educationLevel && scorer.educationLevel) {
        if (target.educationLevel >= scorer.educationLevel) {
            score += config.education.higherOrSameBonus.max;
        } else {
            score += config.education.lowerPenalty.min;
        }
    }

    if (target.religion && target.religion === scorer.religion) {
        score += config.religion.similarBonus;
    }

    const heightDiff = Math.abs(scorer.height - target.height);
    if (heightDiff < 5) score += config.height.maxBonus;
    else if (heightDiff < 10) score += config.height.minBonus;

    if (target.ethnicity && target.ethnicity === scorer.ethnicity) {
        score += config.ethnicity.similarBonus;
    }

    if (target.workplace && target.workplace === scorer.workplace) {
        score += config.workplace.sameBonus;
    }

    if (target.hasCompletedPrompts) score += config.profileCompletion.promptsFilledBonus;
    if (target.hasVoicePrompts) score += config.profileCompletion.voicePromptBonus;

    const substances = ['alcohol', 'smoking', 'marijuana'];
    substances.forEach(substance => {
        const scorerFreq = scorer[`${substance}Frequency`];
        const targetFreq = target[`${substance}Frequency`];

        if (scorerFreq === 'never' && targetFreq !== 'never') {
            score += config.substanceUse.mismatchPenalty;
        } else if (scorerFreq !== 'never' && targetFreq === 'never') {
            score += 0;
        } else {
            if (scorerFreq === targetFreq) {
                score += config.substanceUse.exactMatchBonus;
            } else {
                score += config.substanceUse.closeMatchBonus;
            }
        }
    });

    if (target.hometown && target.hometown === scorer.hometown) {
        score += config.hometown.sameBonus;
    }

    const commonInterests = (scorer.interests || [])
        .filter(i => (target.interests || []).includes(i));
    const interestScore = Math.min(config.interests.maxBonus, commonInterests.length * config.interests.perInterestBonus);
    score += interestScore;

    return Math.round(Math.max(0, score));
}


// 1) Rastgele kullanıcı oluşturma - Updated for new criteria!
exports.createRandomUsers = onRequest(async (req, res) => {
    try {
        let count = parseInt(req.query.count) || 10;
        if (count > 500) count = 500;

        const allInterests = ['seyahat', 'spor', 'sinema', 'müzik', 'sanat', 'kitap', 'oyun', 'yemek', 'teknoloji'];
        const genders = ['male', 'female'];
        const booleans = [true, false];
        const substanceFreq = ['never', 'socially', 'frequently'];
        const educationLevels = { 'Lise': 1, 'Lisans': 2, 'Yüksek Lisans': 3 };
        const politicalViews = ['Apolitical', 'Liberal', 'Conservative', 'Moderate'];
        const religions = ['Agnostic', 'Atheist', 'Muslim', 'Christian', 'Spiritual'];
        const hometowns = ['İstanbul', 'Ankara', 'İzmir', 'Bursa', 'Antalya'];
        const ethnicities = ['Turkish', 'Kurdish', 'Arab', 'Circassian'];

        const batch = db.batch();

        for (let i = 0; i < count; i++) {
            const lat = Math.random() * (41.2 - 40.9) + 40.9;
            const lon = Math.random() * (29.2 - 28.8) + 28.8;
            const age = Math.floor(Math.random() * 38) + 18;
            const gender = genders[Math.floor(Math.random() * genders.length)];
            const educationKeys = Object.keys(educationLevels);

            const docRef = db.collection('users').doc();
            batch.set(docRef, {
                age,
                gender,
                location: { lat, lon },
                interests: [...allInterests].sort(() => 0.5 - Math.random()).slice(0, Math.floor(Math.random() * 4) + 2),
                hasChildren: booleans[Math.floor(Math.random() * booleans.length)],
                wantsChildren: booleans[Math.floor(Math.random() * booleans.length)],
                politicalView: politicalViews[Math.floor(Math.random() * politicalViews.length)],
                educationLevel: educationLevels[educationKeys[Math.floor(Math.random() * educationKeys.length)]],
                religion: religions[Math.floor(Math.random() * religions.length)],
                height: Math.floor(Math.random() * 40) + 150,
                ethnicity: ethnicities[Math.floor(Math.random() * ethnicities.length)],
                workplace: `Company ${i % 10}`,
                hometown: hometowns[Math.floor(Math.random() * hometowns.length)],
                hasCompletedPrompts: booleans[Math.floor(Math.random() * booleans.length)],
                hasVoicePrompts: booleans[Math.floor(Math.random() * booleans.length)],
                usesDrugs: booleans[Math.floor(Math.random() * booleans.length)],
                alcoholFrequency: substanceFreq[Math.floor(Math.random() * substanceFreq.length)],
                smokingFrequency: substanceFreq[Math.floor(Math.random() * substanceFreq.length)],
                marijuanaFrequency: substanceFreq[Math.floor(Math.random() * substanceFreq.length)],
                preferences: {
                    minAge: Math.max(18, age - (Math.floor(Math.random() * 5) + 3)),
                    maxAge: age + (Math.floor(Math.random() * 5) + 3),
                    gender: gender === 'male' ? 'female' : 'male',
                    maxDistance: Math.floor(Math.random() * 41) + 10,
                }
            });
        }
        await batch.commit();
        res.status(200).send(`✅ Successfully created ${count} random users with detailed profiles.`);
    } catch (err) {
        console.error("Error creating users:", err);
        res.status(500).send(`Error: ${err.message}`);
    }
});


exports.processMatches = onRequest({ timeoutSeconds: 300, memory: '1GiB' }, async (req, res) => {
    try {
        // --- 1. Create a dynamic document ID based on the current date ---
        const today = new Date();
        const year = today.getFullYear();
        const month = String(today.getMonth() + 1).padStart(2, '0'); // Add 1 because months are 0-indexed
        const day = String(today.getDate()).padStart(2, '0');
        const dateDocumentId = `${year}-${month}-${day}`; // e.g., "2025-07-16"

        // Get all users from the 'users' collection
        const usersSnap = await db.collection('users').get();
        const users = usersSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        // Object to hold all users' matches for the current day
        const dailyMatchesData = {};

        // Iterate through each user to find their matches
        for (const uA of users) {
            const matches = [];

            for (const uB of users) {
                // Skip self-comparison
                if (uA.id === uB.id) continue;

                // Check mutual compatibility
                if (!checkCompatibility(uA, uB) || !checkCompatibility(uB, uA)) {
                    continue;
                }

                const score = calculateScore(uA, uB);

                if (score > 0) {
                    matches.push({ uuid: uB.id, score });
                }
            }

            // Sort matches by score in descending order
            matches.sort((a, b) => b.score - a.score);

            // Add this user's matches to the dailyMatchesData object
            dailyMatchesData[uA.id] = {
                matches: matches,
            };
        }

        // --- 2. Create a reference to the single document for the current date ---
        // Path: /matches/{dateDocumentId}
        const dateDocRef = db.collection('matches').doc(dateDocumentId);

        // --- 3. Use set() to create or overwrite the single date document with all users' matches ---
        // We use set() without merge:true here to ensure the document contains only the current day's data.
        // If you intended to append to existing data (e.g., if this function runs multiple times a day),
        // you would need to fetch the existing document first, merge, and then set.
        await dateDocRef.set(dailyMatchesData);

        return res.status(200).json({
            status: "success",
            message: `Successfully generated matches for ${users.length} users and saved under date document ID ${dateDocumentId}.`,
            dateDocumentId: dateDocumentId,
            generatedAt: new Date().toISOString()
        });
    } catch (error) {
        console.error("Matching error:", error);
        return res.status(500).json({ status: "error", message: error.message });
    }
});

/**
 * Processes the ranked matches for a given day to create stable couples.
 * This function should run AFTER 'processMatches' has completed.
 * It uses a greedy algorithm based on mutual scores.
 */
exports.createCouplesFromMatches = onRequest({ timeoutSeconds: 300, memory: '1GiB' }, async (req, res) => {
    try {
        // --- 1. Get the Document ID for the day (same logic as in processMatches) ---
        const today = new Date();
        const dateDocumentId = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        const dateDocRef = db.collection('matches').doc(dateDocumentId);
        const couplesDocRef = db.collection('couples').doc(dateDocumentId);

        const docSnap = await dateDocRef.get();
        if (!docSnap.exists) {
            return res.status(404).json({
                status: "error",
                message: `Match document for ${dateDocumentId} not found. Run processMatches first.`,
            });
        }

        const dailyMatchesData = docSnap.data();

        // --- 2. Create a master list of all potential pairings with mutual scores ---
        const allPotentialPairs = [];
        const checkedPairs = new Set(); // To avoid adding both [A,B] and [B,A]

        for (const userIdA in dailyMatchesData) {
            const userAMatches = dailyMatchesData[userIdA].matches || [];

            for (const match of userAMatches) {
                const userIdB = match.uuid;
                const scoreAtoB = match.score;

                // Ensure we don't process the same pair twice (e.g., A->B and B->A)
                const pairKey = [userIdA, userIdB].sort().join('-');
                if (checkedPairs.has(pairKey)) {
                    continue;
                }
                checkedPairs.add(pairKey);

                // Find the score from B to A
                const userBMatches = dailyMatchesData[userIdB]?.matches || [];
                const matchFromBtoA = userBMatches.find(m => m.uuid === userIdA);
                const scoreBtoA = matchFromBtoA ? matchFromBtoA.score : 0;

                const mutualScore = scoreAtoB + scoreBtoA;

                if (mutualScore > 0) {
                    allPotentialPairs.push({
                        pair: [userIdA, userIdB],
                        mutualScore: mutualScore,
                    });
                }
            }
        }

        // --- 3. Sort the master list by the highest mutual score ---
        allPotentialPairs.sort((a, b) => b.mutualScore - a.mutualScore);


        // --- 4. Iterate and form couples, creating a map ---
        const matchedUsers = new Set();
        const finalCouplesMap = {};

        for (const potentialPair of allPotentialPairs) {
            const [user1, user2] = potentialPair.pair;

            // If neither user is already matched, form the couple
            if (!matchedUsers.has(user1) && !matchedUsers.has(user2)) {
                const mutualScore = potentialPair.mutualScore;

                finalCouplesMap[user1] = { partnerId: user2, mutualScore };
                finalCouplesMap[user2] = { partnerId: user1, mutualScore };

                matchedUsers.add(user1);
                matchedUsers.add(user2);
            }
        }

        // --- 5. Save the final couples map to Firestore ---
        // ✅ FIX: Using .set() to create the document if it doesn't exist.
        await couplesDocRef.set({
            couples: finalCouplesMap,
            couplingCompletedAt: new Date().toISOString(),
        });

        // ✅ FIX: Correctly calculating the number of couples formed.
        const numberOfCouples = matchedUsers.size / 2;

        return res.status(200).json({
            status: "success",
            message: `Successfully created ${numberOfCouples} couples.`,
            dateDocumentId: dateDocumentId,
        });

    } catch (error) {
        console.error("Coupling error:", error);
        return res.status(500).json({ status: "error", message: error.message });
    }
});